defmodule SymphonyElixir.ResumeStateTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Codex.ResumeState

  test "write, read, and delete round-trip resume state in a git workspace" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-resume-state-roundtrip-#{System.unique_integer([:positive])}"
      )

    try do
      workspace = create_git_workspace!(test_root)

      attrs = %{
        thread_id: "thread-1",
        session_id: "thread-1-turn-1",
        issue_id: "issue-1",
        issue_identifier: "MT-1",
        issue_state: "In Progress",
        workspace_path: workspace,
        updated_at: DateTime.utc_now() |> DateTime.to_iso8601()
      }

      assert :ok = ResumeState.write(workspace, attrs)

      assert {:ok, state} = ResumeState.read(workspace)
      assert state.thread_id == "thread-1"
      assert state.session_id == "thread-1-turn-1"
      assert state.issue_id == "issue-1"
      assert state.issue_identifier == "MT-1"
      assert state.issue_state == "In Progress"
      assert state.workspace_path == workspace

      assert :ok = ResumeState.delete(workspace)
      assert :missing = ResumeState.read(workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "read returns missing when no resume file exists" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-resume-state-missing-#{System.unique_integer([:positive])}"
      )

    try do
      workspace = create_git_workspace!(test_root)

      assert :missing = ResumeState.read(workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "read returns an error for invalid resume state json" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-resume-state-invalid-#{System.unique_integer([:positive])}"
      )

    try do
      workspace = create_git_workspace!(test_root)
      resume_path = resume_state_path(workspace)

      File.mkdir_p!(Path.dirname(resume_path))
      File.write!(resume_path, "{bad json")

      assert {:error, {:resume_state_decode_failed, _reason}} = ResumeState.read(workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "read returns an error when the resume file cannot be read" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-resume-state-unreadable-#{System.unique_integer([:positive])}"
      )

    try do
      workspace = create_git_workspace!(test_root)

      resume_path = resume_state_path(workspace)
      File.mkdir_p!(Path.dirname(resume_path))
      File.write!(resume_path, Jason.encode!(%{"thread_id" => "thread-unreadable"}))
      File.chmod!(resume_path, 0o000)

      assert {:error, {:resume_state_read_failed, _reason}} = ResumeState.read(workspace)
    after
      File.chmod(resume_state_path(Path.join(test_root, "workspace")), 0o644)
      File.rm_rf(test_root)
    end
  end

  test "read returns an error for invalid resume state payload" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-resume-state-invalid-payload-#{System.unique_integer([:positive])}"
      )

    try do
      workspace = create_git_workspace!(test_root)
      resume_path = resume_state_path(workspace)

      File.mkdir_p!(Path.dirname(resume_path))
      File.write!(resume_path, Jason.encode!(%{"session_id" => "missing-thread"}))

      assert {:error, :invalid_resume_state} = ResumeState.read(workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "write returns an error for invalid resume state attrs" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-resume-state-invalid-attrs-#{System.unique_integer([:positive])}"
      )

    try do
      workspace = create_git_workspace!(test_root)

      assert {:error, :invalid_resume_state} = ResumeState.write(workspace, %{})
    after
      File.rm_rf(test_root)
    end
  end

  test "write returns an error when the resume directory cannot be created" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-resume-state-write-error-#{System.unique_integer([:positive])}"
      )

    try do
      workspace = create_git_workspace!(test_root)

      blocked_path = Path.join(workspace, ".git/symphony")
      File.write!(blocked_path, "not a directory")

      assert {:error, {:resume_state_write_failed, _reason}} =
               ResumeState.write(workspace, %{thread_id: "thread-blocked"})
    after
      File.rm_rf(test_root)
    end
  end

  test "delete returns an error when the resume path is a directory" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-resume-state-delete-error-#{System.unique_integer([:positive])}"
      )

    try do
      workspace = create_git_workspace!(test_root)

      resume_path = resume_state_path(workspace)
      File.mkdir_p!(resume_path)

      assert {:error, {:resume_state_delete_failed, _reason}} = ResumeState.delete(workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "delete ignores a missing resume file in a git workspace" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-resume-state-delete-missing-#{System.unique_integer([:positive])}"
      )

    try do
      workspace = create_git_workspace!(test_root)

      assert :ok = ResumeState.delete(workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "non-git workspaces treat resume state as unavailable" do
    test_root = Path.join(System.tmp_dir!(), "symphony-resume-state-no-git-#{System.unique_integer([:positive])}")

    try do
      workspace = Path.join(test_root, "workspace")
      File.mkdir_p!(workspace)

      assert :missing = ResumeState.read(workspace)
      assert :ok = ResumeState.write(workspace, %{thread_id: "thread-2"})
      assert :ok = ResumeState.delete(workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "remote workspaces are currently treated as non-resumable" do
    workspace = "/tmp/remote-workspace"

    assert :missing = ResumeState.read(workspace, "worker-a")
    assert :ok = ResumeState.write(workspace, %{thread_id: "thread-3"}, "worker-a")
    assert :ok = ResumeState.delete(workspace, "worker-a")
  end

  defp create_git_workspace!(test_root) do
    workspace = Path.join(test_root, "workspace")
    File.mkdir_p!(workspace)

    assert {_output, 0} =
             System.cmd("git", ["-C", workspace, "init", "-b", "main"], stderr_to_stdout: true)

    workspace
  end

  defp resume_state_path(workspace) do
    Path.join(workspace, ".git/symphony/resume.json")
  end
end
