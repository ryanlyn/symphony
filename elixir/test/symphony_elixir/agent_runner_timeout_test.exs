defmodule SymphonyElixir.AgentRunnerTimeoutWorkspace do
  def create_for_issue(_issue_or_identifier, _worker_host, _opts \\ []) do
    maybe_sleep(:create)
    workspace = config!() |> Map.fetch!(:workspace)
    {:ok, workspace}
  end

  def run_before_run_hook(_workspace, _issue_or_identifier, _worker_host) do
    maybe_sleep(:before_run)
    :ok
  end

  def run_after_run_hook(_workspace, _issue_or_identifier, _worker_host) do
    maybe_sleep(:after_run)
    :ok
  end

  defp maybe_sleep(stage) do
    config!()
    |> Map.get(stage)
    |> case do
      timeout_ms when is_integer(timeout_ms) and timeout_ms > 0 ->
        Process.sleep(timeout_ms)

      _ ->
        :ok
    end
  end

  defp config! do
    Application.get_env(:symphony_elixir, __MODULE__, %{})
  end
end

defmodule SymphonyElixir.AgentRunnerTimeoutExecutor do
  @behaviour SymphonyElixir.AgentExecutor

  def start_session(workspace, _opts), do: {:ok, %{workspace: workspace}}

  def run_turn(session, _prompt, _issue, _opts) do
    {:ok, session, %{session_id: "timeout-session"}}
  end

  def stop_session(_session), do: :ok

  def resume_metadata(_session) do
    %{
      agent_kind: "codex",
      resume_id: "timeout-session",
      session_id: "timeout-session"
    }
  end
end

defmodule SymphonyElixir.AgentRunnerTimeoutTest do
  use SymphonyElixir.TestSupport

  setup do
    Application.delete_env(:symphony_elixir, SymphonyElixir.AgentRunnerTimeoutWorkspace)

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, SymphonyElixir.AgentRunnerTimeoutWorkspace)
    end)

    :ok
  end

  test "agent runner times out workspace creation when setup blocks" do
    {test_root, workspace} = fake_workspace_fixture!("MT-SETUP-CREATE-WS")

    Application.put_env(:symphony_elixir, SymphonyElixir.AgentRunnerTimeoutWorkspace, %{
      workspace: workspace,
      create: 200
    })

    try do
      assert_raise RuntimeError, ~r/agent_runner_timeout.*workspace\.create_for_issue.*50/, fn ->
        AgentRunner.run(
          issue_fixture("MT-SETUP-CREATE"),
          nil,
          runner_opts(workspace_create_timeout_ms: 50, hook_timeout_ms: 500)
        )
      end
    after
      File.rm_rf(test_root)
    end
  end

  test "agent runner times out before_run when setup blocks" do
    {test_root, workspace} = fake_workspace_fixture!("MT-SETUP-BEFORE-WS")

    Application.put_env(:symphony_elixir, SymphonyElixir.AgentRunnerTimeoutWorkspace, %{
      workspace: workspace,
      before_run: 200
    })

    try do
      assert_raise RuntimeError, ~r/agent_runner_timeout.*workspace\.run_before_run_hook.*50/, fn ->
        AgentRunner.run(
          issue_fixture("MT-SETUP-BEFORE"),
          nil,
          runner_opts(workspace_create_timeout_ms: 500, hook_timeout_ms: 50)
        )
      end
    after
      File.rm_rf(test_root)
    end
  end

  test "agent runner ignores after_run timeout while logging it" do
    {test_root, workspace} = fake_workspace_fixture!("MT-SETUP-AFTER-WS")

    Application.put_env(:symphony_elixir, SymphonyElixir.AgentRunnerTimeoutWorkspace, %{
      workspace: workspace,
      after_run: 2_000
    })

    started_at = System.monotonic_time(:millisecond)

    try do
      log =
        capture_log(fn ->
          assert :ok =
                   AgentRunner.run(
                     issue_fixture("MT-SETUP-AFTER"),
                     nil,
                     runner_opts(workspace_create_timeout_ms: 500, hook_timeout_ms: 50)
                   )
        end)

      elapsed_ms = System.monotonic_time(:millisecond) - started_at

      assert elapsed_ms < 1_000
      assert log =~ "Ignoring after_run hook failure"
      assert log =~ "workspace.run_after_run_hook"
    after
      File.rm_rf(test_root)
    end
  end

  test "agent runner preserves workspace hook timeout errors for before_run hooks" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-hook-timeout-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_timeout_ms: 10,
        hook_before_run: "sleep 1"
      )

      assert_raise RuntimeError, ~r/workspace_hook_timeout.*before_run.*10/, fn ->
        AgentRunner.run(issue_fixture("MT-SETUP-HOOK"), nil, real_workspace_runner_opts([]))
      end
    after
      File.rm_rf(test_root)
    end
  end

  defp runner_opts(extra_opts) do
    Keyword.merge(
      [
        executor: SymphonyElixir.AgentRunnerTimeoutExecutor,
        workspace_module: SymphonyElixir.AgentRunnerTimeoutWorkspace,
        issue_state_fetcher: fn _issue_ids -> {:ok, []} end
      ],
      extra_opts
    )
  end

  defp real_workspace_runner_opts(extra_opts) do
    Keyword.merge(
      [
        executor: SymphonyElixir.AgentRunnerTimeoutExecutor,
        issue_state_fetcher: fn _issue_ids -> {:ok, []} end
      ],
      extra_opts
    )
  end

  defp issue_fixture(identifier) do
    %Issue{
      id: "issue-#{identifier}",
      identifier: identifier,
      title: "Agent runner timeout coverage",
      description: "Exercise runner setup timeout handling",
      state: "In Progress",
      url: "https://example.org/issues/#{identifier}",
      labels: []
    }
  end

  defp fake_workspace_fixture!(issue_identifier) do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-timeout-fixture-#{System.unique_integer([:positive])}"
      )

    %{workspace: workspace} = create_git_workspace!(test_root, issue_identifier)
    {test_root, workspace}
  end
end
