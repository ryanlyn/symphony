defmodule SymphonyElixir.LiveClaudeResumeE2ETest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.{AgentRunner, Linear, SSH}

  @moduletag :live_e2e
  @moduletag timeout: 300_000

  @live_claude_skip_reason if(
                             System.get_env("SYMPHONY_RUN_REAL_CLAUDE_RESUME_E2E") != "1" or
                               System.get_env("LINEAR_API_KEY") in [nil, ""],
                             do: "set SYMPHONY_RUN_REAL_CLAUDE_RESUME_E2E=1 and LINEAR_API_KEY to enable the real Claude resume e2e tests"
                           )

  @tag skip: @live_claude_skip_reason
  test "agent runner resumes the same real Claude session from local workspace state with MCP tool use" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-claude-resume-live-e2e-#{System.unique_integer([:positive])}"
      )

    token = "claude-resume-token-#{System.unique_integer([:positive])}"
    workspace_root = Path.join(test_root, "workspaces")
    issue_identifier = "MT-REAL-CLAUDE-RESUME"
    workspace = Path.join(workspace_root, issue_identifier)
    first_file = Path.join(workspace, "first_claude_token.txt")
    second_file = Path.join(workspace, "second_claude_token.txt")
    resume_path = Path.join(workspace, ".git/symphony/resume.json")

    try do
      File.mkdir_p!(workspace_root)

      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_api_token: "$LINEAR_API_KEY",
        workspace_root: workspace_root,
        hook_after_create: init_repo_hook(),
        agent_kind: "claude",
        claude_command: "claude",
        claude_permission_mode: "dontAsk",
        prompt: first_prompt(token, "first_claude_token.txt")
      )

      issue = %Linear.Issue{
        id: "issue-real-claude-resume",
        identifier: issue_identifier,
        title: "Real Claude resume e2e",
        description: "Validate local Claude resume against the real CLI and MCP tool",
        state: "In Progress",
        url: "https://example.org/issues/#{issue_identifier}",
        labels: ["backend"]
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)
      assert File.read!(first_file) == token <> "\n"

      first_resume = Jason.decode!(File.read!(resume_path))
      first_resume_id = first_resume["resume_id"]
      assert is_binary(first_resume_id) and first_resume_id != ""

      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_api_token: "$LINEAR_API_KEY",
        workspace_root: workspace_root,
        hook_after_create: init_repo_hook(),
        agent_kind: "claude",
        claude_command: "claude",
        claude_permission_mode: "dontAsk",
        prompt: second_prompt(token, "second_claude_token.txt")
      )

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)
      assert File.read!(second_file) == token <> "\n"

      second_resume = Jason.decode!(File.read!(resume_path))
      assert second_resume["resume_id"] == first_resume_id
    after
      File.rm_rf(test_root)
    end
  end

  @remote_skip_reason if(
                        @live_claude_skip_reason != nil or
                          System.get_env("SYMPHONY_LIVE_SSH_WORKER_HOSTS") in [nil, ""],
                        do: "set SYMPHONY_RUN_REAL_CLAUDE_RESUME_E2E=1, LINEAR_API_KEY, and SYMPHONY_LIVE_SSH_WORKER_HOSTS to enable the remote Claude resume e2e test"
                      )

  @tag skip: @remote_skip_reason
  test "agent runner resumes the same real Claude session on an ssh worker with MCP tool use" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-claude-resume-remote-e2e-#{System.unique_integer([:positive])}"
      )

    workspace_root = "~/.symphony-remote-workspaces"
    issue_identifier = "MT-REAL-CLAUDE-REMOTE"
    worker_host = System.get_env("SYMPHONY_LIVE_SSH_WORKER_HOSTS") |> String.split(",") |> List.first()

    try do
      File.mkdir_p!(test_root)

      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_api_token: "$LINEAR_API_KEY",
        workspace_root: workspace_root,
        worker_ssh_hosts: [worker_host],
        hook_after_create: init_repo_hook(),
        agent_kind: "claude",
        claude_command: "claude",
        claude_permission_mode: "dontAsk",
        prompt: remote_prompt("remote_claude_token.txt", "REMOTE-CLAUDE-OK")
      )

      issue = %Linear.Issue{
        id: "issue-real-claude-remote",
        identifier: issue_identifier,
        title: "Real Claude remote resume e2e",
        description: "Validate remote Claude resume against the real CLI and MCP tool",
        state: "In Progress",
        url: "https://example.org/issues/#{issue_identifier}",
        labels: ["backend"]
      }

      assert :ok =
               AgentRunner.run(issue, self(),
                 worker_host: worker_host,
                 issue_state_fetcher: fn _ -> {:ok, []} end
               )

      runtime_info = receive_runtime_info!(issue.id)
      remote_workspace = runtime_info.workspace_path
      remote_resume_path = Path.join([remote_workspace, ".git", "symphony", "resume.json"])
      remote_token_path = Path.join(remote_workspace, "remote_claude_token.txt")

      assert remote_file_contents!(worker_host, remote_token_path) == "REMOTE-CLAUDE-OK\n"

      first_resume = Jason.decode!(remote_file_contents!(worker_host, remote_resume_path))
      first_resume_id = first_resume["resume_id"]
      assert is_binary(first_resume_id) and first_resume_id != ""

      assert :ok =
               AgentRunner.run(issue, self(),
                 worker_host: worker_host,
                 issue_state_fetcher: fn _ -> {:ok, []} end
               )

      _runtime_info = receive_runtime_info!(issue.id)
      assert remote_file_contents!(worker_host, remote_token_path) == "REMOTE-CLAUDE-OK\n"
      second_resume = Jason.decode!(remote_file_contents!(worker_host, remote_resume_path))
      assert second_resume["resume_id"] == first_resume_id
    after
      File.rm_rf(test_root)
    end
  end

  defp init_repo_hook do
    """
    git init -b main
    git config user.name "Symphony Test User"
    git config user.email "symphony-test@example.com"
    printf '# claude resume e2e\\n' > README.md
    git add README.md
    git commit -m "init"
    """
  end

  defp first_prompt(token, file_name) do
    """
    Use the available Linear GraphQL MCP tool to run a harmless viewer query before changing files.

    Marker string: #{token}

    Create a file named `#{file_name}` in the current working directory whose only contents are the exact marker string above followed by a trailing newline.

    Do not create any other files.
    """
  end

  defp second_prompt(token, file_name) do
    """
    Use the available Linear GraphQL MCP tool again.

    Create a file named `#{file_name}` in the current working directory whose only contents are the exact marker string `#{token}` followed by a trailing newline.

    Do not create any other files.
    """
  end

  defp remote_prompt(file_name, contents) do
    """
    Use the available Linear GraphQL MCP tool to run a harmless viewer query before changing files.

    Create a file named `#{file_name}` in the current working directory whose only contents are the exact text `#{contents}` followed by a trailing newline.

    Do not create any other files.
    """
  end

  defp remote_file_contents!(worker_host, path) do
    command =
      if String.starts_with?(path, "~/") do
        ~s(cat "$HOME/#{String.trim_leading(path, "~/")}")
      else
        "cat #{shell_escape(path)}"
      end

    assert {:ok, {contents, 0}} =
             SSH.run(worker_host, command, stderr_to_stdout: true)

    contents
  end

  defp receive_runtime_info!(issue_id) do
    receive do
      {:worker_runtime_info, ^issue_id, %{workspace_path: workspace_path} = runtime_info}
      when is_binary(workspace_path) ->
        runtime_info

      {:agent_worker_update, ^issue_id, _update} ->
        receive_runtime_info!(issue_id)

      {:codex_worker_update, ^issue_id, _update} ->
        receive_runtime_info!(issue_id)
    after
      5_000 ->
        flunk("timed out waiting for worker runtime info for #{inspect(issue_id)}")
    end
  end

  defp shell_escape(value) when is_binary(value) do
    "'" <> String.replace(value, "'", "'\"'\"'") <> "'"
  end
end
