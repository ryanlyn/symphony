defmodule SymphonyElixirWeb.Presenter do
  @moduledoc """
  Shared projections for the observability API and dashboard.
  """

  alias SymphonyElixir.{Config, Orchestrator, StatusDashboard}

  @spec state_payload(GenServer.name(), timeout()) :: map()
  def state_payload(orchestrator, snapshot_timeout_ms) do
    generated_at = DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()

    case Orchestrator.snapshot(orchestrator, snapshot_timeout_ms) do
      %{} = snapshot ->
        usage_totals = snapshot.usage_totals
        blocked = Map.get(snapshot, :blocked, [])

        %{
          generated_at: generated_at,
          counts: %{
            running: length(snapshot.running),
            retrying: length(snapshot.retrying),
            blocked: length(blocked)
          },
          blocked_by_reason: blocked_counts(blocked),
          running: Enum.map(snapshot.running, &running_entry_payload/1),
          retrying: Enum.map(snapshot.retrying, &retry_entry_payload/1),
          blocked: Enum.map(blocked, &blocked_entry_payload/1),
          usage_totals: usage_totals,
          rate_limits: snapshot.rate_limits
        }

      :timeout ->
        %{generated_at: generated_at, error: %{code: "snapshot_timeout", message: "Snapshot timed out"}}

      :unavailable ->
        %{generated_at: generated_at, error: %{code: "snapshot_unavailable", message: "Snapshot unavailable"}}
    end
  end

  @spec issue_payload(String.t(), GenServer.name(), timeout()) :: {:ok, map()} | {:error, :issue_not_found}
  def issue_payload(issue_identifier, orchestrator, snapshot_timeout_ms) when is_binary(issue_identifier) do
    case Orchestrator.snapshot(orchestrator, snapshot_timeout_ms) do
      %{} = snapshot ->
        running = Enum.find(snapshot.running, &(&1.identifier == issue_identifier))
        retry = Enum.find(snapshot.retrying, &(&1.identifier == issue_identifier))

        if is_nil(running) and is_nil(retry) do
          {:error, :issue_not_found}
        else
          {:ok, issue_payload_body(issue_identifier, running, retry)}
        end

      _ ->
        {:error, :issue_not_found}
    end
  end

  @spec refresh_payload(GenServer.name()) :: {:ok, map()} | {:error, :unavailable}
  def refresh_payload(orchestrator) do
    case Orchestrator.request_refresh(orchestrator) do
      :unavailable ->
        {:error, :unavailable}

      payload ->
        {:ok, Map.update!(payload, :requested_at, &DateTime.to_iso8601/1)}
    end
  end

  defp issue_payload_body(issue_identifier, running, retry) do
    %{
      issue_identifier: issue_identifier,
      issue_id: issue_id_from_entries(running, retry),
      status: issue_status(running, retry),
      workspace: %{
        path: workspace_path(issue_identifier, running, retry),
        host: workspace_host(running, retry)
      },
      attempts: %{
        restart_count: restart_count(retry),
        current_retry_attempt: retry_attempt(retry)
      },
      running: running && running_issue_payload(running),
      retry: retry && retry_issue_payload(retry),
      logs: %{
        codex_session_logs: []
      },
      recent_events: (running && recent_events_payload(running)) || [],
      last_error: retry && retry.error,
      tracked: %{}
    }
  end

  defp issue_id_from_entries(running, retry),
    do: (running && running.issue_id) || (retry && retry.issue_id)

  defp restart_count(retry), do: max(retry_attempt(retry) - 1, 0)
  defp retry_attempt(nil), do: 0
  defp retry_attempt(retry), do: retry.attempt || 0

  defp issue_status(_running, nil), do: "running"
  defp issue_status(nil, _retry), do: "retrying"
  defp issue_status(_running, _retry), do: "running"

  defp running_entry_payload(entry) do
    %{
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      state: entry.state,
      worker_host: Map.get(entry, :worker_host),
      workspace_path: Map.get(entry, :workspace_path),
      session_id: entry.session_id,
      turn_count: Map.get(entry, :turn_count, 0),
      agent_kind: Map.get(entry, :agent_kind, "codex"),
      executor_pid: Map.get(entry, :executor_pid),
      usage_totals: Map.get(entry, :usage_totals),
      last_event: Map.get(entry, :last_agent_event),
      last_message: summarize_message(Map.get(entry, :last_agent_message)),
      started_at: iso8601(entry.started_at),
      last_event_at: iso8601(entry.last_agent_timestamp),
      tokens: %{
        input_tokens: Map.get(entry.usage_totals, :input_tokens, 0),
        output_tokens: Map.get(entry.usage_totals, :output_tokens, 0),
        total_tokens: Map.get(entry.usage_totals, :total_tokens, 0)
      }
    }
  end

  defp retry_entry_payload(entry) do
    %{
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: due_at_iso8601(entry.due_in_ms),
      error: entry.error,
      worker_host: Map.get(entry, :worker_host),
      workspace_path: Map.get(entry, :workspace_path)
    }
  end

  defp running_issue_payload(running) do
    %{
      worker_host: Map.get(running, :worker_host),
      workspace_path: Map.get(running, :workspace_path),
      session_id: running.session_id,
      turn_count: Map.get(running, :turn_count, 0),
      agent_kind: Map.get(running, :agent_kind, "codex"),
      executor_pid: Map.get(running, :executor_pid),
      usage_totals: Map.get(running, :usage_totals),
      state: running.state,
      started_at: iso8601(running.started_at),
      last_event: Map.get(running, :last_agent_event),
      last_message: summarize_message(Map.get(running, :last_agent_message)),
      last_event_at: iso8601(running.last_agent_timestamp),
      tokens: %{
        input_tokens: Map.get(running.usage_totals, :input_tokens, 0),
        output_tokens: Map.get(running.usage_totals, :output_tokens, 0),
        total_tokens: Map.get(running.usage_totals, :total_tokens, 0)
      }
    }
  end

  defp retry_issue_payload(retry) do
    %{
      attempt: retry.attempt,
      due_at: due_at_iso8601(retry.due_in_ms),
      error: retry.error,
      worker_host: Map.get(retry, :worker_host),
      workspace_path: Map.get(retry, :workspace_path)
    }
  end

  defp blocked_entry_payload(entry) do
    %{
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      state: entry.state,
      reason: block_reason_label(entry.reason)
    }
  end

  defp workspace_path(issue_identifier, running, retry) do
    (running && Map.get(running, :workspace_path)) ||
      (retry && Map.get(retry, :workspace_path)) ||
      Path.join(Config.settings!().workspace.root, issue_identifier)
  end

  defp workspace_host(running, retry) do
    (running && Map.get(running, :worker_host)) || (retry && Map.get(retry, :worker_host))
  end

  defp recent_events_payload(running) do
    [
      %{
        at: iso8601(Map.get(running, :last_agent_timestamp)),
        event: Map.get(running, :last_agent_event),
        message: summarize_message(Map.get(running, :last_agent_message))
      }
    ]
    |> Enum.reject(&is_nil(&1.at))
  end

  defp summarize_message(nil), do: nil
  defp summarize_message(message), do: StatusDashboard.humanize_agent_message(message)

  defp blocked_counts(blocked_entries) when is_list(blocked_entries) do
    Enum.reduce(blocked_entries, %{global: 0, local: 0, worker: 0}, fn entry, counts ->
      case entry.reason do
        :global_concurrency_cap -> Map.update!(counts, :global, &(&1 + 1))
        :local_concurrency_cap -> Map.update!(counts, :local, &(&1 + 1))
        :worker_host_capacity -> Map.update!(counts, :worker, &(&1 + 1))
        _ -> counts
      end
    end)
  end

  defp block_reason_label(:global_concurrency_cap), do: "blocked by global cap"
  defp block_reason_label(:local_concurrency_cap), do: "blocked by local cap"
  defp block_reason_label(:worker_host_capacity), do: "blocked by worker host capacity"
  defp block_reason_label(other), do: to_string(other)

  defp due_at_iso8601(due_in_ms) when is_integer(due_in_ms) do
    DateTime.utc_now()
    |> DateTime.add(div(due_in_ms, 1_000), :second)
    |> DateTime.truncate(:second)
    |> DateTime.to_iso8601()
  end

  defp due_at_iso8601(_due_in_ms), do: nil

  defp iso8601(%DateTime{} = datetime) do
    datetime
    |> DateTime.truncate(:second)
    |> DateTime.to_iso8601()
  end

  defp iso8601(_datetime), do: nil
end
