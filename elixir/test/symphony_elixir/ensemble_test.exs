defmodule SymphonyElixir.EnsembleTest do
  use SymphonyElixir.TestSupport

  describe "ensemble_size resolution" do
    test "issue label takes precedence over config" do
      write_workflow_file!(Workflow.workflow_file_path(), ensemble_size: 2)
      issue = %Issue{id: "i1", identifier: "T-1", title: "T", state: "Todo", labels: ["ensemble:3"]}
      assert Issue.ensemble_size(issue) == 3
      assert Config.settings!().agent.ensemble_size == 2
    end

    test "config default used when no label" do
      write_workflow_file!(Workflow.workflow_file_path(), ensemble_size: 2)
      issue = %Issue{id: "i1", identifier: "T-1", title: "T", state: "Todo", labels: []}
      assert Issue.ensemble_size(issue) == nil
      assert Config.settings!().agent.ensemble_size == 2
    end
  end

  describe "ToolServer barrier" do
    test "ensemble_size=1 passes state transition through directly" do
      test_pid = self()

      opts = [
        issue_id: "issue-1",
        slot_index: 0,
        ensemble_size: 1,
        linear_client: fn query, variables, _opts ->
          send(test_pid, {:linear_call, query, variables})
          {:ok, %{"data" => %{"issueUpdate" => %{"success" => true}}}}
        end
      ]

      query = "mutation { issueUpdate(id: $id, input: {stateId: $stateId}) { success } }"
      variables = %{"id" => "issue-1", "stateId" => "state-done"}

      {:ok, result} = SymphonyElixir.ToolServer.handle_linear_graphql(query, variables, opts)

      assert result["data"]["issueUpdate"]["success"] == true
      assert result["_symphony_barrier"]["status"] == "executed"
      assert result["_symphony_barrier"]["ensemble_size"] == 1
      assert_receive {:linear_call, ^query, ^variables}
    end

    test "non-state-transition queries pass through without barrier" do
      test_pid = self()

      opts = [
        issue_id: "issue-1",
        slot_index: 0,
        ensemble_size: 3,
        linear_client: fn query, variables, _opts ->
          send(test_pid, {:linear_call, query, variables})
          {:ok, %{"data" => %{"issue" => %{"id" => "issue-1"}}}}
        end
      ]

      query = "query { issue(id: $id) { id title } }"
      variables = %{"id" => "issue-1"}

      {:ok, result} = SymphonyElixir.ToolServer.handle_linear_graphql(query, variables, opts)

      assert result["data"]["issue"]["id"] == "issue-1"
      refute Map.has_key?(result, "_symphony_barrier")
      assert_receive {:linear_call, ^query, ^variables}
    end

    test "state_transition_mutation? detection" do
      assert SymphonyElixir.ToolServer.state_transition_mutation?(
               "mutation { issueUpdate(id: $id, input: {stateId: $sid}) { success } }",
               %{"id" => "i1", "stateId" => "s1"}
             )

      refute SymphonyElixir.ToolServer.state_transition_mutation?(
               "mutation { issueUpdate(id: $id, input: {title: $t}) { success } }",
               %{"id" => "i1", "title" => "new"}
             )

      refute SymphonyElixir.ToolServer.state_transition_mutation?(
               "query { issue(id: $id) { id } }",
               %{"id" => "i1"}
             )
    end
  end

  describe "workspace slot paths" do
    test "different slots create different workspace directories" do
      write_workflow_file!(Workflow.workflow_file_path())
      {:ok, ws0} = Workspace.create_for_issue("ENSEMBLE-1", nil, slot_index: 0)
      {:ok, ws1} = Workspace.create_for_issue("ENSEMBLE-1", nil, slot_index: 1)
      {:ok, ws2} = Workspace.create_for_issue("ENSEMBLE-1", nil, slot_index: 2)

      assert ws0 != ws1
      assert ws1 != ws2
      assert String.ends_with?(ws0, "/ENSEMBLE-1/0")
      assert String.ends_with?(ws1, "/ENSEMBLE-1/1")
      assert String.ends_with?(ws2, "/ENSEMBLE-1/2")

      assert File.dir?(ws0)
      assert File.dir?(ws1)
      assert File.dir?(ws2)
    end
  end

  describe "prompt builder ensemble context" do
    test "includes slot context for ensemble agents" do
      write_workflow_file!(Workflow.workflow_file_path())
      issue = %Issue{id: "i1", identifier: "T-1", title: "Test", description: "D", state: "Todo"}

      prompt = PromptBuilder.build_prompt(issue, slot_index: 2, ensemble_size: 5)
      assert prompt =~ "slot 2 of 5"
      assert prompt =~ "slot-2"
    end

    test "no ensemble context for single agents" do
      write_workflow_file!(Workflow.workflow_file_path())
      issue = %Issue{id: "i1", identifier: "T-1", title: "Test", description: "D", state: "Todo"}

      prompt = PromptBuilder.build_prompt(issue)
      refute prompt =~ "Ensemble context"
    end
  end

  # ---------------------------------------------------------------------------
  # Test helpers for orchestrator handler tests
  # ---------------------------------------------------------------------------

  defp base_state(overrides \\ %{}) do
    Map.merge(
      %Orchestrator.State{
        poll_interval_ms: 30_000,
        max_concurrent_agents: 10,
        next_poll_due_at_ms: nil,
        poll_check_in_progress: false,
        tick_timer_ref: nil,
        tick_token: nil,
        running: %{},
        completed: MapSet.new(),
        claimed: MapSet.new(),
        retry_attempts: %{},
        ensembles: %{},
        usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
        codex_rate_limits: nil
      },
      overrides
    )
  end

  defp running_entry_for(issue_id, slot_index, overrides \\ %{}) do
    Map.merge(
      %{
        pid: self(),
        ref: make_ref(),
        agent_kind: "codex",
        identifier: "T-1",
        issue: %Issue{id: issue_id, identifier: "T-1", title: "Test", state: "In Progress"},
        slot_index: slot_index,
        ensemble_size: 2,
        worker_host: nil,
        workspace_path: nil,
        session_id: nil,
        executor_pid: nil,
        usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
        usage_last_reported_input_tokens: 0,
        usage_last_reported_output_tokens: 0,
        usage_last_reported_total_tokens: 0,
        last_agent_message: nil,
        last_agent_timestamp: nil,
        last_agent_event: nil,
        turn_count: 0,
        retry_attempt: 0,
        started_at: DateTime.utc_now()
      },
      overrides
    )
  end

  defp ensemble_for(size) do
    %{
      size: size,
      completed_slots: MapSet.new(),
      failed_slots: MapSet.new(),
      last_intent: nil
    }
  end

  # ---------------------------------------------------------------------------
  # Test 1: worker_runtime_info routes to correct slot
  # ---------------------------------------------------------------------------

  describe "worker_runtime_info routes to correct slot" do
    test "runtime_info with slot_index=0 updates only slot 0, not slot 1" do
      issue_id = "ensemble-routing-issue"

      running = %{
        {issue_id, 0} => running_entry_for(issue_id, 0),
        {issue_id, 1} => running_entry_for(issue_id, 1)
      }

      state = base_state(%{running: running})

      runtime_info = %{
        slot_index: 0,
        agent_kind: "claude",
        worker_host: "worker-a.local",
        workspace_path: "/tmp/ws/ensemble-routing-issue/0"
      }

      {:noreply, new_state} =
        Orchestrator.handle_info({:worker_runtime_info, issue_id, runtime_info}, state)

      slot0 = new_state.running[{issue_id, 0}]
      slot1 = new_state.running[{issue_id, 1}]

      assert slot0.workspace_path == "/tmp/ws/ensemble-routing-issue/0"
      assert slot0.agent_kind == "claude"
      assert slot0.worker_host == "worker-a.local"

      assert slot1.workspace_path == nil
      assert slot1.agent_kind == "codex"
      assert slot1.worker_host == nil
    end

    test "runtime_info with slot_index=1 updates only slot 1" do
      issue_id = "ensemble-routing-issue"

      running = %{
        {issue_id, 0} => running_entry_for(issue_id, 0),
        {issue_id, 1} => running_entry_for(issue_id, 1)
      }

      state = base_state(%{running: running})

      runtime_info = %{
        slot_index: 1,
        agent_kind: "claude",
        worker_host: "worker-b.local",
        workspace_path: "/tmp/ws/ensemble-routing-issue/1"
      }

      {:noreply, new_state} =
        Orchestrator.handle_info({:worker_runtime_info, issue_id, runtime_info}, state)

      slot0 = new_state.running[{issue_id, 0}]
      slot1 = new_state.running[{issue_id, 1}]

      assert slot0.workspace_path == nil
      assert slot0.agent_kind == "codex"
      assert slot0.worker_host == nil

      assert slot1.workspace_path == "/tmp/ws/ensemble-routing-issue/1"
      assert slot1.agent_kind == "claude"
      assert slot1.worker_host == "worker-b.local"
    end

    test "runtime_info for missing slot key is ignored" do
      issue_id = "ensemble-routing-issue"
      running = %{{issue_id, 0} => running_entry_for(issue_id, 0)}
      state = base_state(%{running: running})

      runtime_info = %{slot_index: 5, workspace_path: "/tmp/ws/ghost"}

      {:noreply, new_state} =
        Orchestrator.handle_info({:worker_runtime_info, issue_id, runtime_info}, state)

      assert new_state == state
    end

    test "runtime_info is idempotent once workspace_path is set" do
      issue_id = "ensemble-routing-issue"

      running = %{
        {issue_id, 0} =>
          running_entry_for(issue_id, 0, %{workspace_path: "/original"})
      }

      state = base_state(%{running: running})

      runtime_info = %{
        slot_index: 0,
        workspace_path: "/should-not-overwrite"
      }

      {:noreply, new_state} =
        Orchestrator.handle_info({:worker_runtime_info, issue_id, runtime_info}, state)

      assert new_state.running[{issue_id, 0}].workspace_path == "/original"
    end
  end

  # ---------------------------------------------------------------------------
  # Test 2: agent_worker_update routes to correct slot
  # ---------------------------------------------------------------------------

  describe "agent_worker_update routes to correct slot" do
    test "update with slot_index=1 updates only slot 1" do
      issue_id = "ensemble-update-issue"

      running = %{
        {issue_id, 0} => running_entry_for(issue_id, 0),
        {issue_id, 1} => running_entry_for(issue_id, 1)
      }

      state = base_state(%{running: running})

      update = %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        slot_index: 1,
        agent_kind: "claude",
        session_id: "session-slot-1"
      }

      {:noreply, new_state} =
        Orchestrator.handle_info({:agent_worker_update, issue_id, update}, state)

      slot0 = new_state.running[{issue_id, 0}]
      slot1 = new_state.running[{issue_id, 1}]

      assert slot0.session_id == nil
      assert slot0.last_agent_event == nil

      assert slot1.session_id == "session-slot-1"
      assert slot1.last_agent_event == :notification
    end

    test "update with slot_index=0 does not duplicate tokens to slot 1" do
      issue_id = "ensemble-token-issue"

      running = %{
        {issue_id, 0} => running_entry_for(issue_id, 0),
        {issue_id, 1} => running_entry_for(issue_id, 1)
      }

      state = base_state(%{running: running})

      update = %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        slot_index: 0,
        agent_kind: "codex",
        usage: %{input_tokens: 100, output_tokens: 50, total_tokens: 150}
      }

      {:noreply, new_state} =
        Orchestrator.handle_info({:agent_worker_update, issue_id, update}, state)

      slot0 = new_state.running[{issue_id, 0}]
      slot1 = new_state.running[{issue_id, 1}]

      assert slot1.usage_totals == %{
               input_tokens: 0,
               output_tokens: 0,
               total_tokens: 0,
               seconds_running: 0
             }

      assert slot0.last_agent_event == :notification
      assert slot1.last_agent_event == nil
    end

    test "update for missing slot key is ignored" do
      issue_id = "ensemble-update-issue"
      running = %{{issue_id, 0} => running_entry_for(issue_id, 0)}
      state = base_state(%{running: running})

      update = %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        slot_index: 99
      }

      {:noreply, new_state} =
        Orchestrator.handle_info({:agent_worker_update, issue_id, update}, state)

      assert new_state.running == state.running
    end
  end

  # ---------------------------------------------------------------------------
  # Test 3: barrier_register with ensemble_size > 1
  # ---------------------------------------------------------------------------

  describe "barrier_register with ensemble_size > 1" do
    test "first two of three slots get deferred replies" do
      issue_id = "barrier-lifecycle-issue"
      ensemble = ensemble_for(3)
      state = base_state(%{ensembles: %{issue_id => ensemble}})

      query = "mutation { issueUpdate(id: $id, input: {stateId: $sid}) { success } }"
      vars_0 = %{"id" => issue_id, "stateId" => "state-done"}

      {:reply, reply_0, state_after_0} =
        Orchestrator.handle_call(
          {:barrier_register, issue_id, 0, query, vars_0},
          {self(), make_ref()},
          state
        )

      assert {:deferred, ensemble_0} = reply_0
      assert MapSet.member?(ensemble_0.completed_slots, 0)
      refute MapSet.member?(ensemble_0.completed_slots, 1)
      assert ensemble_0.last_intent == {query, vars_0, 0}

      vars_1 = %{"id" => issue_id, "stateId" => "state-done-v2"}

      {:reply, reply_1, state_after_1} =
        Orchestrator.handle_call(
          {:barrier_register, issue_id, 1, query, vars_1},
          {self(), make_ref()},
          state_after_0
        )

      assert {:deferred, ensemble_1} = reply_1
      assert MapSet.member?(ensemble_1.completed_slots, 0)
      assert MapSet.member?(ensemble_1.completed_slots, 1)
      refute MapSet.member?(ensemble_1.completed_slots, 2)
      assert ensemble_1.last_intent == {query, vars_1, 1}

      persisted = state_after_1.ensembles[issue_id]
      assert MapSet.size(persisted.completed_slots) == 2
    end

    test "last-writer-wins: third slot's variables are used for the mutation" do
      test_pid = self()
      issue_id = "barrier-lww-issue"

      linear_stub = fn query, variables, _opts ->
        send(test_pid, {:linear_call, query, variables})
        {:ok, %{"data" => %{"issueUpdate" => %{"success" => true}}}}
      end

      prev = Application.get_env(:symphony_elixir, :barrier_linear_client)
      Application.put_env(:symphony_elixir, :barrier_linear_client, linear_stub)
      on_exit(fn -> if prev, do: Application.put_env(:symphony_elixir, :barrier_linear_client, prev), else: Application.delete_env(:symphony_elixir, :barrier_linear_client) end)

      ensemble = ensemble_for(3)
      state = base_state(%{ensembles: %{issue_id => ensemble}})

      query = "mutation { issueUpdate(id: $id, input: {stateId: $sid}) { success } }"
      vars_0 = %{"id" => issue_id, "stateId" => "state-a"}
      vars_1 = %{"id" => issue_id, "stateId" => "state-b"}
      vars_2 = %{"id" => issue_id, "stateId" => "state-c"}

      {:reply, {:deferred, _}, s1} =
        Orchestrator.handle_call(
          {:barrier_register, issue_id, 0, query, vars_0},
          {self(), make_ref()},
          state
        )

      {:reply, {:deferred, _}, s2} =
        Orchestrator.handle_call(
          {:barrier_register, issue_id, 1, query, vars_1},
          {self(), make_ref()},
          s1
        )

      # Third slot triggers execution via the stubbed Linear client.
      {:reply, {:executed, _response, executed_ensemble}, s3} =
        Orchestrator.handle_call(
          {:barrier_register, issue_id, 2, query, vars_2},
          {self(), make_ref()},
          s2
        )

      persisted = s3.ensembles[issue_id]
      assert persisted.last_intent == {query, vars_2, 2}
      assert MapSet.size(persisted.completed_slots) == 3
      assert MapSet.size(executed_ensemble.completed_slots) == 3

      # Verify the stub was called with the LAST slot's variables (last-writer-wins)
      assert_receive {:linear_call, ^query, ^vars_2}
    end

    test "returns {:error, :no_ensemble} when issue has no ensemble state" do
      state = base_state()

      {:reply, reply, new_state} =
        Orchestrator.handle_call(
          {:barrier_register, "unknown-issue", 0, "mutation {}", %{}},
          {self(), make_ref()},
          state
        )

      assert reply == {:error, :no_ensemble}
      assert new_state == state
    end

    test "failed_slots reduce effective_size" do
      test_pid = self()
      issue_id = "barrier-failed-slot-issue"

      linear_stub = fn query, variables, _opts ->
        send(test_pid, {:linear_call, query, variables})
        {:ok, %{"data" => %{"issueUpdate" => %{"success" => true}}}}
      end

      prev = Application.get_env(:symphony_elixir, :barrier_linear_client)
      Application.put_env(:symphony_elixir, :barrier_linear_client, linear_stub)
      on_exit(fn -> if prev, do: Application.put_env(:symphony_elixir, :barrier_linear_client, prev), else: Application.delete_env(:symphony_elixir, :barrier_linear_client) end)

      ensemble = %{
        size: 3,
        completed_slots: MapSet.new(),
        failed_slots: MapSet.new([2]),
        last_intent: nil
      }

      state = base_state(%{ensembles: %{issue_id => ensemble}})
      query = "mutation { issueUpdate(id: $id, input: {stateId: $sid}) { success } }"
      vars = %{"id" => issue_id, "stateId" => "state-done"}

      # With one failed slot, effective_size = 3 - 1 = 2.
      # First slot -> deferred (1 < 2)
      {:reply, {:deferred, _}, s1} =
        Orchestrator.handle_call(
          {:barrier_register, issue_id, 0, query, vars},
          {self(), make_ref()},
          state
        )

      # Second slot -> triggers execution (2 >= 2)
      {:reply, {:executed, _response, _ensemble}, s2} =
        Orchestrator.handle_call(
          {:barrier_register, issue_id, 1, query, vars},
          {self(), make_ref()},
          s1
        )

      persisted = s2.ensembles[issue_id]
      assert MapSet.size(persisted.completed_slots) == 2
      assert_receive {:linear_call, ^query, ^vars}
    end
  end

  # ---------------------------------------------------------------------------
  # Test 4: barrier_register persists state on Linear API error
  # ---------------------------------------------------------------------------

  describe "barrier_register persists state on Linear API error" do
    test "ensemble state is persisted even when Linear API call fails" do
      issue_id = "barrier-error-persist-issue"

      linear_stub = fn _query, _variables, _opts ->
        {:error, :stubbed_failure}
      end

      prev = Application.get_env(:symphony_elixir, :barrier_linear_client)
      Application.put_env(:symphony_elixir, :barrier_linear_client, linear_stub)
      on_exit(fn -> if prev, do: Application.put_env(:symphony_elixir, :barrier_linear_client, prev), else: Application.delete_env(:symphony_elixir, :barrier_linear_client) end)

      ensemble = ensemble_for(2)
      state = base_state(%{ensembles: %{issue_id => ensemble}})

      query = "mutation { issueUpdate(id: $id, input: {stateId: $sid}) { success } }"
      vars_0 = %{"id" => issue_id, "stateId" => "state-done"}
      vars_1 = %{"id" => issue_id, "stateId" => "state-done"}

      {:reply, {:deferred, _}, s1} =
        Orchestrator.handle_call(
          {:barrier_register, issue_id, 0, query, vars_0},
          {self(), make_ref()},
          state
        )

      # Second slot triggers the Linear API call, which returns a stubbed error.
      {:reply, {:error, _reason}, s2} =
        Orchestrator.handle_call(
          {:barrier_register, issue_id, 1, query, vars_1},
          {self(), make_ref()},
          s1
        )

      # Even on error, ensemble state should be fully persisted
      persisted = s2.ensembles[issue_id]
      assert persisted != nil
      assert MapSet.member?(persisted.completed_slots, 0)
      assert MapSet.member?(persisted.completed_slots, 1)
      assert MapSet.size(persisted.completed_slots) == 2
      assert persisted.last_intent == {query, vars_1, 1}
    end
  end

  # ---------------------------------------------------------------------------
  # Test 5: BarrierController HTTP endpoint
  # ---------------------------------------------------------------------------

  describe "BarrierController HTTP endpoint" do
    import Phoenix.ConnTest
    import Plug.Conn
    @endpoint SymphonyElixirWeb.Endpoint

    defmodule BarrierOrchestrator do
      use GenServer

      def start_link(opts) do
        name = Keyword.fetch!(opts, :name)
        GenServer.start_link(__MODULE__, opts, name: name)
      end

      def init(opts), do: {:ok, opts}

      def handle_call({:barrier_register, _issue_id, slot_index, _query, _variables}, _from, state) do
        response_mode = Keyword.get(state, :barrier_response, :deferred)

        case response_mode do
          :executed ->
            api_response = %{"data" => %{"issueUpdate" => %{"success" => true}}}

            ensemble_state = %{
              completed_slots: MapSet.new([0, 1, slot_index]),
              ensemble_size: 3
            }

            {:reply, {:executed, api_response, ensemble_state}, state}

          :deferred ->
            ensemble_state = %{
              completed_slots: MapSet.new([slot_index]),
              ensemble_size: 3
            }

            {:reply, {:deferred, ensemble_state}, state}

          :error ->
            {:reply, {:error, :linear_api_timeout}, state}
        end
      end

      def handle_call(:snapshot, _from, state) do
        {:reply, %{}, state}
      end

      def handle_call(:request_refresh, _from, state) do
        {:reply, :unavailable, state}
      end
    end

    defp start_barrier_endpoint(orchestrator_name, barrier_response) do
      {:ok, _pid} =
        BarrierOrchestrator.start_link(
          name: orchestrator_name,
          barrier_response: barrier_response
        )

      endpoint_config =
        :symphony_elixir
        |> Application.get_env(SymphonyElixirWeb.Endpoint, [])
        |> Keyword.merge(
          server: false,
          secret_key_base: String.duplicate("s", 64),
          orchestrator: orchestrator_name,
          snapshot_timeout_ms: 50
        )

      Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
      start_supervised!({SymphonyElixirWeb.Endpoint, []})
    end

    setup do
      endpoint_config = Application.get_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, [])

      on_exit(fn ->
        Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
      end)

      :ok
    end

    defp post_barrier(params) do
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> post("/api/barrier/check", params)
    end

    defp barrier_params(overrides \\ %{}) do
      Map.merge(
        %{
          "issue_id" => "barrier-http-issue",
          "slot_index" => 0,
          "query" => "mutation { issueUpdate(id: $id, input: {stateId: $sid}) { success } }",
          "variables" => %{"id" => "barrier-http-issue", "stateId" => "state-done"}
        },
        overrides
      )
    end

    test "POST /api/barrier/check returns barrier metadata for deferred response" do
      orchestrator_name = Module.concat(__MODULE__, :DeferredBarrierOrchestrator)
      start_barrier_endpoint(orchestrator_name, :deferred)

      body = post_barrier(barrier_params()) |> json_response(200)

      barrier = body["_symphony_barrier"]
      assert barrier["status"] == "deferred"
      assert barrier["slot"] == 0
      assert barrier["ensemble_size"] == 3
      assert is_list(barrier["completed_slots"])
    end

    test "POST /api/barrier/check returns barrier metadata for executed response" do
      orchestrator_name = Module.concat(__MODULE__, :ExecutedBarrierOrchestrator)
      start_barrier_endpoint(orchestrator_name, :executed)

      body = post_barrier(barrier_params(%{"slot_index" => 2})) |> json_response(200)

      assert body["data"]["issueUpdate"]["success"] == true
      assert body["_symphony_barrier"]["status"] == "executed"
      assert body["_symphony_barrier"]["ensemble_size"] == 3
    end

    test "POST /api/barrier/check returns 500 on error" do
      orchestrator_name = Module.concat(__MODULE__, :ErrorBarrierOrchestrator)
      start_barrier_endpoint(orchestrator_name, :error)

      body = post_barrier(barrier_params(%{"query" => "mutation {}", "variables" => %{}})) |> json_response(500)

      assert Map.has_key?(body, "error")
    end

    test "string slot_index values are coerced to integers" do
      orchestrator_name = Module.concat(__MODULE__, :CoercionBarrierOrchestrator)
      start_barrier_endpoint(orchestrator_name, :deferred)

      body =
        post_barrier(barrier_params(%{"issue_id" => "barrier-coerce-issue", "slot_index" => "2"}))
        |> json_response(200)

      assert body["_symphony_barrier"]["slot"] == 2
    end

    test "POST /api/barrier/check returns 400 for missing parameters" do
      orchestrator_name = Module.concat(__MODULE__, :MissingParamBarrierOrchestrator)
      start_barrier_endpoint(orchestrator_name, :deferred)

      body = post_barrier(%{"issue_id" => "only-issue-id"}) |> json_response(400)

      assert body["error"] =~ "Missing required parameters"
    end
  end
end
