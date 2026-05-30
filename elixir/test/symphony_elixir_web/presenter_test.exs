defmodule SymphonyElixirWeb.PresenterTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixirWeb.Presenter

  defmodule SnapshotServer do
    use GenServer

    def start_link(snapshot) do
      GenServer.start_link(__MODULE__, snapshot, name: __MODULE__)
    end

    def init(snapshot), do: {:ok, snapshot}

    def handle_call(:snapshot, _from, state), do: {:reply, state, state}
  end

  # --- Existing fallback path sanitization tests ---

  test "issue payload fallback sanitizes running workspace path when runtime path is missing" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!({SnapshotServer, snapshot_with_running("MONO 151/?bad")})

    assert {:ok, payload} = Presenter.issue_payload("MONO 151/?bad", SnapshotServer, 1_000)
    assert payload.workspace.path == "/tmp/workspaces/MONO_151__bad"
    assert payload.workspace.host == nil
    assert payload.status == "running"
  end

  test "issue payload fallback sanitizes retry workspace path when runtime path is missing" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!({SnapshotServer, snapshot_with_retry("MONO 151/?bad")})

    assert {:ok, payload} = Presenter.issue_payload("MONO 151/?bad", SnapshotServer, 1_000)
    assert payload.workspace.path == "/tmp/workspaces/MONO_151__bad"
    assert payload.workspace.host == nil
    assert payload.status == "retrying"
  end

  # --- Error case: identifier not found in snapshot ---

  test "issue payload returns error when identifier is not in running or retrying" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!({SnapshotServer, snapshot_with_running("OTHER-123")})

    assert {:error, :issue_not_found} =
             Presenter.issue_payload("NONEXISTENT-456", SnapshotServer, 1_000)
  end

  test "issue payload returns error when snapshot is empty (no running or retrying)" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!({SnapshotServer, empty_snapshot()})

    assert {:error, :issue_not_found} =
             Presenter.issue_payload("ANY-ID", SnapshotServer, 1_000)
  end

  # --- Error case: orchestrator unavailable (server not registered) ---

  test "issue payload returns error when orchestrator process is not available" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    # Do not start the SnapshotServer - simulate :unavailable from Orchestrator.snapshot
    assert {:error, :issue_not_found} =
             Presenter.issue_payload("SOME-ID", SnapshotServer, 1_000)
  end

  # --- Identifier present in BOTH running and retrying: status should be "running" ---

  test "issue payload returns status running when identifier is in both running and retrying" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!({SnapshotServer, snapshot_with_both("DUAL-ISSUE-1")})

    assert {:ok, payload} = Presenter.issue_payload("DUAL-ISSUE-1", SnapshotServer, 1_000)
    assert payload.status == "running"
    assert payload.issue_identifier == "DUAL-ISSUE-1"
    # Both running and retry subsections should be populated
    assert payload.running != nil
    assert payload.retry != nil
  end

  # --- Entry with workspace_path already set (non-fallback path) ---

  test "issue payload uses entry workspace_path when present on running entry" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!(
      {SnapshotServer, snapshot_with_running_workspace("T-99", "/custom/workspace/T-99")}
    )

    assert {:ok, payload} = Presenter.issue_payload("T-99", SnapshotServer, 1_000)
    assert payload.workspace.path == "/custom/workspace/T-99"
    assert payload.status == "running"
  end

  test "issue payload uses entry workspace_path from retry when running has no path" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!(
      {SnapshotServer, snapshot_with_retry_workspace("T-100", "/custom/retry/workspace")}
    )

    assert {:ok, payload} = Presenter.issue_payload("T-100", SnapshotServer, 1_000)
    assert payload.workspace.path == "/custom/retry/workspace"
    assert payload.status == "retrying"
  end

  # --- Entry with worker_host set (host should be populated) ---

  test "issue payload returns host when worker_host is present on running entry" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!(
      {SnapshotServer,
       snapshot_with_running_worker_host("REMOTE-1", "worker-1.example.com", "/remote/path")}
    )

    assert {:ok, payload} = Presenter.issue_payload("REMOTE-1", SnapshotServer, 1_000)
    assert payload.workspace.host == "worker-1.example.com"
    assert payload.workspace.path == "/remote/path"
    assert payload.status == "running"
  end

  test "issue payload returns host from retry entry when only retry has worker_host" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!(
      {SnapshotServer,
       snapshot_with_retry_worker_host("REMOTE-2", "retry-worker.example.com", "/retry/path")}
    )

    assert {:ok, payload} = Presenter.issue_payload("REMOTE-2", SnapshotServer, 1_000)
    assert payload.workspace.host == "retry-worker.example.com"
    assert payload.workspace.path == "/retry/path"
    assert payload.status == "retrying"
  end

  # --- Identifiers with characters that should be preserved (dots, dashes) ---

  test "issue payload preserves dots and dashes in identifier for fallback path" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!({SnapshotServer, snapshot_with_running("my-project.v2.1-beta")})

    assert {:ok, payload} = Presenter.issue_payload("my-project.v2.1-beta", SnapshotServer, 1_000)
    # Dots and dashes are preserved by safe_identifier; only non-alphanum/dot/dash are replaced
    assert payload.workspace.path == "/tmp/workspaces/my-project.v2.1-beta"
  end

  test "issue payload replaces only non-safe characters in fallback path" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    # Mix of safe (letters, digits, dots, dashes) and unsafe (spaces, slashes, @, #)
    start_supervised!({SnapshotServer, snapshot_with_running("feat/@user#123/fix it")})

    assert {:ok, payload} =
             Presenter.issue_payload("feat/@user#123/fix it", SnapshotServer, 1_000)

    assert payload.workspace.path == "/tmp/workspaces/feat__user_123_fix_it"
  end

  # --- Payload structure verification ---

  test "issue payload contains expected top-level keys for a running entry" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!({SnapshotServer, snapshot_with_running("STRUCT-1")})

    assert {:ok, payload} = Presenter.issue_payload("STRUCT-1", SnapshotServer, 1_000)
    assert payload.issue_identifier == "STRUCT-1"
    assert payload.issue_id == "issue-1"
    assert is_map(payload.workspace)
    assert is_map(payload.attempts)
    assert payload.attempts.restart_count == 0
    assert payload.attempts.current_retry_attempt == 0
    assert payload.running != nil
    assert payload.retry == nil
    assert is_map(payload.logs)
    assert is_list(payload.recent_events)
    assert payload.last_error == nil
    assert is_map(payload.tracked)
  end

  test "issue payload contains expected structure for a retrying entry" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!({SnapshotServer, snapshot_with_retry("STRUCT-2")})

    assert {:ok, payload} = Presenter.issue_payload("STRUCT-2", SnapshotServer, 1_000)
    assert payload.issue_identifier == "STRUCT-2"
    assert payload.issue_id == "issue-1"
    assert payload.running == nil
    assert payload.retry != nil
    assert payload.retry.attempt == 2
    assert payload.attempts.restart_count == 1
    assert payload.attempts.current_retry_attempt == 2
    assert payload.last_error == "retry later"
    assert payload.recent_events == []
  end

  # --- Helper functions ---

  defp empty_snapshot do
    %{
      running: [],
      retrying: [],
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      rate_limits: nil
    }
  end

  defp snapshot_with_running(identifier) do
    %{
      running: [
        %{
          issue_id: "issue-1",
          identifier: identifier,
          state: "running",
          started_at: DateTime.utc_now(),
          session_id: "sess-1",
          usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0},
          last_agent_timestamp: nil
        }
      ],
      retrying: [],
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      rate_limits: nil
    }
  end

  defp snapshot_with_retry(identifier) do
    %{
      running: [],
      retrying: [
        %{
          issue_id: "issue-1",
          identifier: identifier,
          attempt: 2,
          due_in_ms: 1_000,
          error: "retry later"
        }
      ],
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      rate_limits: nil
    }
  end

  defp snapshot_with_both(identifier) do
    %{
      running: [
        %{
          issue_id: "issue-1",
          identifier: identifier,
          state: "running",
          started_at: DateTime.utc_now(),
          session_id: "sess-dual",
          usage_totals: %{input_tokens: 10, output_tokens: 5, total_tokens: 15},
          last_agent_timestamp: nil
        }
      ],
      retrying: [
        %{
          issue_id: "issue-1",
          identifier: identifier,
          attempt: 3,
          due_in_ms: 2_000,
          error: "previous error"
        }
      ],
      usage_totals: %{input_tokens: 10, output_tokens: 5, total_tokens: 15, seconds_running: 0},
      rate_limits: nil
    }
  end

  defp snapshot_with_running_workspace(identifier, workspace_path) do
    %{
      running: [
        %{
          issue_id: "issue-1",
          identifier: identifier,
          state: "running",
          started_at: DateTime.utc_now(),
          session_id: "sess-ws",
          workspace_path: workspace_path,
          usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0},
          last_agent_timestamp: nil
        }
      ],
      retrying: [],
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      rate_limits: nil
    }
  end

  defp snapshot_with_retry_workspace(identifier, workspace_path) do
    %{
      running: [],
      retrying: [
        %{
          issue_id: "issue-1",
          identifier: identifier,
          attempt: 1,
          due_in_ms: 500,
          error: "transient",
          workspace_path: workspace_path
        }
      ],
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      rate_limits: nil
    }
  end

  defp snapshot_with_running_worker_host(identifier, worker_host, workspace_path) do
    %{
      running: [
        %{
          issue_id: "issue-1",
          identifier: identifier,
          state: "running",
          started_at: DateTime.utc_now(),
          session_id: "sess-remote",
          worker_host: worker_host,
          workspace_path: workspace_path,
          usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0},
          last_agent_timestamp: nil
        }
      ],
      retrying: [],
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      rate_limits: nil
    }
  end

  defp snapshot_with_retry_worker_host(identifier, worker_host, workspace_path) do
    %{
      running: [],
      retrying: [
        %{
          issue_id: "issue-1",
          identifier: identifier,
          attempt: 1,
          due_in_ms: 500,
          error: "host error",
          worker_host: worker_host,
          workspace_path: workspace_path
        }
      ],
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      rate_limits: nil
    }
  end
end
