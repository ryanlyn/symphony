defmodule SymphonyElixir.AgentRunnerRuntimeWorkspace do
  def create_for_issue(_issue_or_identifier, _worker_host, _opts \\ []) do
    {:ok, config!().workspace}
  end

  def run_before_run_hook(_workspace, _issue_or_identifier, _worker_host), do: :ok
  def run_after_run_hook(_workspace, _issue_or_identifier, _worker_host), do: :ok

  defp config! do
    Application.fetch_env!(:symphony_elixir, __MODULE__)
  end
end

defmodule SymphonyElixir.AgentRunnerRuntimeExecutor do
  @behaviour SymphonyElixir.AgentExecutor

  def start_session(workspace, _opts) do
    {:ok, %{workspace: workspace, turn_count: 0}}
  end

  def run_turn(%{turn_count: turn_count} = session, prompt, _issue, _opts) do
    trace({:turn, turn_count + 1, prompt})

    {:ok, %{session | turn_count: turn_count + 1}, %{session_id: "runtime-session"}}
  end

  def stop_session(%{turn_count: turn_count}) do
    trace({:stop_session, turn_count})
    :ok
  end

  def resume_metadata(_session) do
    %{
      agent_kind: config!().resume_agent_kind,
      resume_id: "runtime-resume",
      session_id: "runtime-session"
    }
  end

  defp trace(message) do
    if pid = config!().trace_pid do
      send(pid, message)
    end
  end

  defp config! do
    Application.fetch_env!(:symphony_elixir, __MODULE__)
  end
end

defmodule SymphonyElixir.AgentRunnerRuntimeTest do
  use SymphonyElixir.TestSupport

  setup do
    Application.delete_env(:symphony_elixir, SymphonyElixir.AgentRunnerRuntimeWorkspace)
    Application.delete_env(:symphony_elixir, SymphonyElixir.AgentRunnerRuntimeExecutor)

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, SymphonyElixir.AgentRunnerRuntimeWorkspace)
      Application.delete_env(:symphony_elixir, SymphonyElixir.AgentRunnerRuntimeExecutor)
    end)

    :ok
  end

  test "agent runner refreshes max_turns after active issue state changes" do
    {test_root, workspace_root, workspace} = fake_workspace_fixture!("MT-RUNTIME-TURNS")

    Application.put_env(:symphony_elixir, SymphonyElixir.AgentRunnerRuntimeWorkspace, %{workspace: workspace})

    Application.put_env(:symphony_elixir, SymphonyElixir.AgentRunnerRuntimeExecutor, %{
      resume_agent_kind: "codex",
      trace_pid: self()
    })

    write_workflow_file!(Workflow.workflow_file_path(),
      workspace_root: workspace_root,
      agent_kind: "codex",
      max_turns: 2,
      status_overrides: %{
        "Todo" => %{agent: %{max_turns: 2}},
        "In Progress" => %{agent: %{max_turns: 5}}
      }
    )

    state_fetcher = sequential_state_fetcher(["In Progress", "In Progress", "Done"])

    issue = issue_fixture("MT-RUNTIME-TURNS", "Todo")

    try do
      assert :ok =
               AgentRunner.run(
                 issue,
                 nil,
                 executor: SymphonyElixir.AgentRunnerRuntimeExecutor,
                 workspace_module: SymphonyElixir.AgentRunnerRuntimeWorkspace,
                 issue_state_fetcher: state_fetcher
               )

      assert_receive {:turn, 1, first_prompt}
      assert_receive {:turn, 2, second_prompt}
      assert_receive {:turn, 3, third_prompt}
      assert_receive {:stop_session, 3}

      assert first_prompt =~ "You are an agent for this repository."
      assert second_prompt =~ "continuation turn #2 of 5"
      assert third_prompt =~ "continuation turn #3 of 5"
    after
      File.rm_rf(test_root)
    end
  end

  test "agent runner ends the current run when agent.kind changes between turns" do
    {test_root, workspace_root, workspace} = fake_workspace_fixture!("MT-RUNTIME-KIND")

    Application.put_env(:symphony_elixir, SymphonyElixir.AgentRunnerRuntimeWorkspace, %{workspace: workspace})

    Application.put_env(:symphony_elixir, SymphonyElixir.AgentRunnerRuntimeExecutor, %{
      resume_agent_kind: "codex",
      trace_pid: self()
    })

    write_workflow_file!(Workflow.workflow_file_path(),
      workspace_root: workspace_root,
      agent_kind: "codex",
      status_overrides: %{
        "Todo" => %{agent: %{kind: "codex"}},
        "In Progress" => %{agent: %{kind: "claude"}}
      }
    )

    state_fetcher = sequential_state_fetcher(["In Progress"])

    issue = issue_fixture("MT-RUNTIME-KIND", "Todo")

    try do
      assert :ok =
               AgentRunner.run(
                 issue,
                 nil,
                 executor: SymphonyElixir.AgentRunnerRuntimeExecutor,
                 workspace_module: SymphonyElixir.AgentRunnerRuntimeWorkspace,
                 issue_state_fetcher: state_fetcher
               )

      assert_receive {:turn, 1, first_prompt}
      assert_receive {:stop_session, 1}
      refute_received {:turn, 2, _prompt}

      assert first_prompt =~ "You are an agent for this repository."
    after
      File.rm_rf(test_root)
    end
  end

  test "agent runner ends the current run when same-executor runtime settings change" do
    {test_root, workspace_root, workspace} = fake_workspace_fixture!("MT-RUNTIME-TIMEOUT")

    Application.put_env(:symphony_elixir, SymphonyElixir.AgentRunnerRuntimeWorkspace, %{workspace: workspace})

    Application.put_env(:symphony_elixir, SymphonyElixir.AgentRunnerRuntimeExecutor, %{
      resume_agent_kind: "claude",
      trace_pid: self()
    })

    write_workflow_file!(Workflow.workflow_file_path(),
      workspace_root: workspace_root,
      agent_kind: "claude",
      claude_turn_timeout_ms: 1_000,
      status_overrides: %{
        "Todo" => %{agent: %{kind: "claude"}, claude: %{turn_timeout_ms: 1_000}},
        "In Progress" => %{agent: %{kind: "claude"}, claude: %{turn_timeout_ms: 2_000}}
      }
    )

    state_fetcher = sequential_state_fetcher(["In Progress"])

    issue = issue_fixture("MT-RUNTIME-TIMEOUT", "Todo")

    try do
      assert :ok =
               AgentRunner.run(
                 issue,
                 nil,
                 executor: SymphonyElixir.AgentRunnerRuntimeExecutor,
                 workspace_module: SymphonyElixir.AgentRunnerRuntimeWorkspace,
                 issue_state_fetcher: state_fetcher
               )

      assert_receive {:turn, 1, _prompt}
      assert_receive {:stop_session, 1}
      refute_received {:turn, 2, _prompt}
    after
      File.rm_rf(test_root)
    end
  end

  defp sequential_state_fetcher(states) when is_list(states) do
    key = {__MODULE__, make_ref()}
    Process.put(key, states)

    fn [_issue_id] ->
      state =
        case Process.get(key) do
          [next_state | rest] ->
            Process.put(key, rest)
            next_state

          [] ->
            List.last(states)
        end

      {:ok,
       [
         %Issue{
           id: "issue-runtime",
           identifier: "MT-RUNTIME",
           title: "Refresh runtime settings",
           description: "Exercise state-aware runtime refresh",
           state: state
         }
       ]}
    end
  end

  defp issue_fixture(identifier, state) do
    %Issue{
      id: "issue-#{identifier}",
      identifier: identifier,
      title: "Agent runner runtime refresh coverage",
      description: "Exercise runtime refresh between turns",
      state: state,
      url: "https://example.org/issues/#{identifier}",
      labels: []
    }
  end

  defp fake_workspace_fixture!(issue_identifier) do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-runtime-#{System.unique_integer([:positive])}"
      )

    %{workspace_root: workspace_root, workspace: workspace} = create_git_workspace!(test_root, issue_identifier)
    {test_root, workspace_root, workspace}
  end
end
