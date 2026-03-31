defmodule SymphonyElixir.LiveResumeE2ETest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.{AgentRunner, Linear}

  @moduletag :live_e2e
  @moduletag timeout: 300_000

  @live_e2e_skip_reason if(System.get_env("SYMPHONY_RUN_REAL_CODEX_RESUME_E2E") != "1",
                          do: "set SYMPHONY_RUN_REAL_CODEX_RESUME_E2E=1 to enable the real local Codex resume e2e test"
                        )

  @tag skip: @live_e2e_skip_reason
  test "agent runner resumes the same real Codex thread from local workspace state" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-resume-live-e2e-#{System.unique_integer([:positive])}"
      )

    token = "resume-token-#{System.unique_integer([:positive])}"
    workspace_root = Path.join(test_root, "workspaces")
    issue_identifier = "MT-REAL-RESUME"
    workspace = Path.join(workspace_root, issue_identifier)
    first_file = Path.join(workspace, "first_token.txt")
    second_file = Path.join(workspace, "second_token.txt")
    resume_path = Path.join(workspace, ".git/symphony/resume.json")

    try do
      File.mkdir_p!(workspace_root)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: init_repo_hook(),
        codex_command: "codex app-server",
        codex_approval_policy: "never",
        codex_thread_sandbox: "workspace-write",
        codex_turn_timeout_ms: 600_000,
        codex_stall_timeout_ms: 600_000,
        prompt: first_prompt(token)
      )

      issue = %Linear.Issue{
        id: "issue-real-resume",
        identifier: issue_identifier,
        title: "Real Codex resume e2e",
        description: "Validate local thread resume against a real Codex app-server",
        state: "In Progress",
        url: "https://example.org/issues/#{issue_identifier}",
        labels: ["backend"]
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)
      assert File.read!(first_file) == token <> "\n"

      first_resume = Jason.decode!(File.read!(resume_path))
      first_thread_id = first_resume["thread_id"]
      assert is_binary(first_thread_id) and first_thread_id != ""
      assert first_resume["issue_state"] == "In Progress"
      assert is_nil(first_resume["session_id"])

      File.rm!(first_file)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: init_repo_hook(),
        codex_command: "codex app-server",
        codex_approval_policy: "never",
        codex_thread_sandbox: "workspace-write",
        codex_turn_timeout_ms: 600_000,
        codex_stall_timeout_ms: 600_000,
        prompt: second_prompt(token)
      )

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)
      assert File.read!(second_file) == token <> "\n"

      second_resume = Jason.decode!(File.read!(resume_path))
      assert second_resume["thread_id"] == first_thread_id
      assert second_resume["issue_state"] == "In Progress"
      assert is_nil(second_resume["session_id"])
    after
      File.rm_rf(test_root)
    end
  end

  @tag skip: @live_e2e_skip_reason
  test "agent runner starts fresh when the local resume file is missing" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-resume-live-missing-file-#{System.unique_integer([:positive])}"
      )

    workspace_root = Path.join(test_root, "workspaces")
    issue_identifier = "MT-REAL-RESUME-MISSING"
    workspace = Path.join(workspace_root, issue_identifier)
    first_file = Path.join(workspace, "first_missing_token.txt")
    second_file = Path.join(workspace, "second_missing_token.txt")
    resume_path = Path.join(workspace, ".git/symphony/resume.json")

    try do
      File.mkdir_p!(workspace_root)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: init_repo_hook(),
        codex_command: "codex app-server",
        codex_approval_policy: "never",
        codex_thread_sandbox: "workspace-write",
        codex_turn_timeout_ms: 600_000,
        codex_stall_timeout_ms: 600_000,
        prompt: literal_file_prompt("first_missing_token.txt", "FIRST-RUN")
      )

      issue = %Linear.Issue{
        id: "issue-real-resume-missing",
        identifier: issue_identifier,
        title: "Real Codex resume missing file e2e",
        description: "Validate fresh thread creation when local resume state is missing",
        state: "In Progress",
        url: "https://example.org/issues/#{issue_identifier}",
        labels: ["backend"]
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)
      assert File.read!(first_file) == "FIRST-RUN\n"

      first_resume = Jason.decode!(File.read!(resume_path))
      first_thread_id = first_resume["thread_id"]
      assert is_binary(first_thread_id) and first_thread_id != ""

      File.rm!(resume_path)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: init_repo_hook(),
        codex_command: "codex app-server",
        codex_approval_policy: "never",
        codex_thread_sandbox: "workspace-write",
        codex_turn_timeout_ms: 600_000,
        codex_stall_timeout_ms: 600_000,
        prompt: literal_file_prompt("second_missing_token.txt", "SECOND-RUN")
      )

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)
      assert File.read!(second_file) == "SECOND-RUN\n"

      second_resume = Jason.decode!(File.read!(resume_path))
      second_thread_id = second_resume["thread_id"]
      assert is_binary(second_thread_id) and second_thread_id != ""
      assert second_resume["issue_state"] == "In Progress"
      refute second_thread_id == first_thread_id
    after
      File.rm_rf(test_root)
    end
  end

  @tag skip: @live_e2e_skip_reason
  test "agent runner starts fresh after orchestrator-style resume invalidation" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-resume-live-error-recreate-#{System.unique_integer([:positive])}"
      )

    token = "error-token-#{System.unique_integer([:positive])}"
    workspace_root = Path.join(test_root, "workspaces")
    issue_identifier = "MT-REAL-RESUME-ERROR"
    workspace = Path.join(workspace_root, issue_identifier)
    recovery_file = Path.join(workspace, "after_error_token.txt")
    resume_path = Path.join(workspace, ".git/symphony/resume.json")

    try do
      File.mkdir_p!(workspace_root)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: init_repo_hook(),
        codex_command: "codex app-server",
        codex_approval_policy: "never",
        codex_thread_sandbox: "workspace-write",
        codex_turn_timeout_ms: 1,
        codex_stall_timeout_ms: 600_000,
        prompt: first_prompt(token)
      )

      issue = %Linear.Issue{
        id: "issue-real-resume-error",
        identifier: issue_identifier,
        title: "Real Codex resume error recreate e2e",
        description: "Validate fresh thread creation after a turn error",
        state: "In Progress",
        url: "https://example.org/issues/#{issue_identifier}",
        labels: ["backend"]
      }

      assert_raise RuntimeError, fn ->
        AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)
      end

      errored_resume = Jason.decode!(File.read!(resume_path))
      assert errored_resume["issue_state"] == "In Progress"

      # The orchestrator owns invalidating resumability after failed runs.
      File.rm!(resume_path)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: init_repo_hook(),
        codex_command: "codex app-server",
        codex_approval_policy: "never",
        codex_thread_sandbox: "workspace-write",
        codex_turn_timeout_ms: 600_000,
        codex_stall_timeout_ms: 600_000,
        prompt: after_error_prompt()
      )

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)

      assert File.read!(recovery_file) == "UNKNOWN\n"

      recovered_resume = Jason.decode!(File.read!(resume_path))
      recovered_thread_id = recovered_resume["thread_id"]
      assert is_binary(recovered_thread_id) and recovered_thread_id != ""
      assert recovered_resume["issue_state"] == "In Progress"
      refute String.contains?(File.read!(recovery_file), token)
    after
      File.rm_rf(test_root)
    end
  end

  @tag skip: @live_e2e_skip_reason
  test "agent runner starts fresh after a status transition even when local resume state exists" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-resume-live-status-transition-#{System.unique_integer([:positive])}"
      )

    workspace_root = Path.join(test_root, "workspaces")
    issue_identifier = "MT-REAL-RESUME-STATUS"
    workspace = Path.join(workspace_root, issue_identifier)
    first_file = Path.join(workspace, "first_status_token.txt")
    second_file = Path.join(workspace, "second_status_token.txt")
    resume_path = Path.join(workspace, ".git/symphony/resume.json")

    try do
      File.mkdir_p!(workspace_root)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: init_repo_hook(),
        codex_command: "codex app-server",
        codex_approval_policy: "never",
        codex_thread_sandbox: "workspace-write",
        codex_turn_timeout_ms: 600_000,
        codex_stall_timeout_ms: 600_000,
        prompt: literal_file_prompt("first_status_token.txt", "STATUS-ONE")
      )

      issue = %Linear.Issue{
        id: "issue-real-resume-status",
        identifier: issue_identifier,
        title: "Real Codex resume status transition e2e",
        description: "Validate fresh thread creation when issue status changes",
        state: "In Progress",
        url: "https://example.org/issues/#{issue_identifier}",
        labels: ["backend"]
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)
      assert File.read!(first_file) == "STATUS-ONE\n"

      first_resume = Jason.decode!(File.read!(resume_path))
      first_thread_id = first_resume["thread_id"]
      assert is_binary(first_thread_id) and first_thread_id != ""

      transitioned_issue = %{issue | state: "Rework"}

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: init_repo_hook(),
        codex_command: "codex app-server",
        codex_approval_policy: "never",
        codex_thread_sandbox: "workspace-write",
        codex_turn_timeout_ms: 600_000,
        codex_stall_timeout_ms: 600_000,
        prompt: literal_file_prompt("second_status_token.txt", "STATUS-TWO")
      )

      assert :ok = AgentRunner.run(transitioned_issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)
      assert File.read!(second_file) == "STATUS-TWO\n"

      second_resume = Jason.decode!(File.read!(resume_path))
      second_thread_id = second_resume["thread_id"]
      assert is_binary(second_thread_id) and second_thread_id != ""
      refute second_thread_id == first_thread_id
      assert second_resume["issue_state"] == "Rework"
    after
      File.rm_rf(test_root)
    end
  end

  defp init_repo_hook do
    """
    git init -b main
    git config user.name "Symphony Test User"
    git config user.email "symphony-test@example.com"
    printf '# resume e2e\\n' > README.md
    git add README.md
    git commit -m "init"
    """
  end

  defp literal_file_prompt(file_name, contents) do
    """
    Create a file named `#{file_name}` in the current working directory whose only contents are the exact text `#{contents}` followed by a trailing newline.

    Do not create any other files.
    """
  end

  defp first_prompt(token) do
    """
    You are in a temporary local git workspace for an automated resume test.

    Secret token: #{token}

    Create a file named `first_token.txt` in the current working directory whose only contents are the exact token above followed by a trailing newline.

    Do not create any other files.
    Do not mention the token anywhere except in that file.
    """
  end

  defp second_prompt(_token) do
    """
    This is a resumed thread test.

    Without reading hidden Codex session files, without using git history, and without using the network, create a file named `second_token.txt` in the current working directory whose only contents are the exact secret token from the previous turn in this same thread followed by a trailing newline.

    If you cannot recover the exact token from thread context alone, write `UNKNOWN` followed by a trailing newline.

    Do not create any other files.
    """
  end

  defp after_error_prompt do
    """
    A previous turn in some prior run may have failed.

    Without reading hidden Codex session files, without using git history, and without using the network, create a file named `after_error_token.txt` in the current working directory whose only contents are the exact secret token from the previous failed turn in this same thread followed by a trailing newline.

    If you cannot recover the exact token from thread context alone, write `UNKNOWN` followed by a trailing newline.

    Do not create any other files.
    """
  end
end
