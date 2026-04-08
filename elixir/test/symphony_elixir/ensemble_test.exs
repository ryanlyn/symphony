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

  describe "workspace slot paths" do
    test "different slots create different workspace directories" do
      write_workflow_file!(Workflow.workflow_file_path())
      {:ok, ws0} = Workspace.create_for_issue("ENSEMBLE-1", nil, slot_index: 0, ensemble_size: 3)
      {:ok, ws1} = Workspace.create_for_issue("ENSEMBLE-1", nil, slot_index: 1, ensemble_size: 3)
      {:ok, ws2} = Workspace.create_for_issue("ENSEMBLE-1", nil, slot_index: 2, ensemble_size: 3)

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
    test "renders nested ensemble template variables" do
      write_workflow_file!(
        Workflow.workflow_file_path(),
        prompt: """
        {% if ensemble.enabled %}slot={{ ensemble.slot_index }}/{{ ensemble.size }}{% else %}solo{% endif %}
        """
      )

      issue = %Issue{id: "i1", identifier: "T-1", title: "Test", description: "D", state: "Todo"}

      assert PromptBuilder.build_prompt(issue, slot_index: 2, ensemble_size: 5) == "slot=2/5"
    end

    test "keeps ensemble object available for solo runs" do
      write_workflow_file!(
        Workflow.workflow_file_path(),
        prompt: """
        {% if ensemble.enabled %}multi{% else %}solo={{ ensemble.slot_index }}/{{ ensemble.size }}{% endif %}
        """
      )

      issue = %Issue{id: "i1", identifier: "T-1", title: "Test", description: "D", state: "Todo"}

      assert PromptBuilder.build_prompt(issue) == "solo=0/1"
    end
  end

  defp base_state(overrides) do
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
        {issue_id, 0} => running_entry_for(issue_id, 0, %{workspace_path: "/original"})
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
end
