defmodule SymphonyElixirWeb.Presenter do
  @moduledoc """
  Shared projections for the observability API and dashboard.
  """

  alias SymphonyElixir.{Config, LogFile, Orchestrator, StatusDashboard, Workspace}

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

  @spec runs_payload(map(), GenServer.name(), timeout()) ::
          {:ok, map()} | {:error, :snapshot_timeout | :snapshot_unavailable | :run_not_found}
  def runs_payload(params, orchestrator, snapshot_timeout_ms) when is_map(params) do
    generated_at = DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()

    case Orchestrator.snapshot(orchestrator, snapshot_timeout_ms) do
      %{} = snapshot ->
        runs =
          snapshot
          |> Map.get(:run_history, [])
          |> Enum.map(&run_entry_payload/1)
          |> filter_runs(params)

        run_view_payload(generated_at, runs, params)

      :timeout ->
        {:error, :snapshot_timeout}

      :unavailable ->
        {:error, :snapshot_unavailable}
    end
  end

  defp run_view_payload(generated_at, runs, params) do
    cond do
      truthy_param?(params, "cost") ->
        {:ok,
         %{
           generated_at: generated_at,
           view: "cost",
           summary: cost_summary_payload(runs)
         }}

      truthy_param?(params, "retries") ->
        {:ok,
         %{
           generated_at: generated_at,
           view: "retries",
           issues: retries_payload(runs)
         }}

      true ->
        run_lookup_payload(generated_at, runs, params)
    end
  end

  defp run_lookup_payload(generated_at, runs, %{"id" => run_id}) when is_binary(run_id) do
    normalized_id = String.trim(run_id)

    if normalized_id == "" do
      runs_list_payload(generated_at, runs, %{})
    else
      case Enum.find(runs, &(&1.id == normalized_id)) do
        nil ->
          {:error, :run_not_found}

        run ->
          related_runs =
            runs
            |> Enum.reject(&(&1.id == run.id))
            |> Enum.filter(&(&1.issue_id == run.issue_id))
            |> Enum.take(10)

          {:ok,
           %{
             generated_at: generated_at,
             view: "run",
             run: run,
             related_runs: related_runs
           }}
      end
    end
  end

  defp run_lookup_payload(generated_at, runs, params) do
    runs_list_payload(generated_at, runs, params)
  end

  defp runs_list_payload(generated_at, runs, params) do
    visible_runs = Enum.take(runs, limit_param(params))

    {:ok,
     %{
       generated_at: generated_at,
       view: "runs",
       summary: runs_summary_payload(runs),
       runs: visible_runs
     }}
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
      Path.join(Config.settings!().workspace.root, Workspace.safe_identifier(issue_identifier))
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

  defp filter_runs(runs, params) when is_list(runs) and is_map(params) do
    runs
    |> maybe_filter_issue(params["issue"])
    |> maybe_filter_failed(truthy_param?(params, "failed"))
  end

  defp maybe_filter_issue(runs, issue) when is_binary(issue) do
    normalized = String.trim(issue)

    Enum.filter(runs, fn run ->
      run.issue_identifier == normalized or run.issue_id == normalized
    end)
  end

  defp maybe_filter_issue(runs, _issue), do: runs

  defp maybe_filter_failed(runs, true) do
    Enum.filter(runs, &(&1.outcome in ["failed", "stalled"]))
  end

  defp maybe_filter_failed(runs, false), do: runs

  defp truthy_param?(params, key) when is_map(params) do
    case Map.get(params, key) do
      value when value in [true, "true", "1", 1, "yes", "on"] -> true
      _ -> false
    end
  end

  defp limit_param(params) when is_map(params) do
    case Integer.parse(to_string(Map.get(params, "limit", "20"))) do
      {limit, ""} when limit > 0 -> min(limit, 200)
      _ -> 20
    end
  end

  defp run_entry_payload(entry) do
    usage_totals = Map.get(entry, :usage_totals, %{})
    issue_identifier = Map.get(entry, :issue_identifier) || Map.get(entry, :identifier)
    session_id = Map.get(entry, :session_id)
    workspace_path = Map.get(entry, :workspace_path)
    log_file = Application.get_env(:symphony_elixir, :log_file, LogFile.default_log_file()) |> Path.expand()

    %{
      id: Map.get(entry, :id),
      issue_id: Map.get(entry, :issue_id),
      issue_identifier: issue_identifier,
      issue_title: Map.get(entry, :issue_title),
      state: Map.get(entry, :state),
      slot_index: Map.get(entry, :slot_index, 0),
      ensemble_size: Map.get(entry, :ensemble_size, 1),
      agent_kind: Map.get(entry, :agent_kind, "codex"),
      outcome: outcome_label(Map.get(entry, :outcome)),
      retry_attempt: Map.get(entry, :retry_attempt, 0),
      worker_host: Map.get(entry, :worker_host),
      workspace_path: workspace_path,
      resume_id: Map.get(entry, :resume_id),
      session_id: session_id,
      executor_pid: Map.get(entry, :executor_pid),
      usage_totals: usage_totals,
      turn_count: Map.get(entry, :turn_count, 0),
      failure_reason: Map.get(entry, :failure_reason),
      last_event: Map.get(entry, :last_agent_event),
      last_message: summarize_message(Map.get(entry, :last_agent_message)),
      last_event_at: iso8601(Map.get(entry, :last_agent_timestamp)),
      started_at: iso8601(Map.get(entry, :started_at)),
      ended_at: iso8601(Map.get(entry, :ended_at)),
      duration_ms: Map.get(entry, :duration_ms),
      cost: Map.get(entry, :cost, %{estimated_cost_usd: nil}),
      tokens: %{
        input_tokens: Map.get(usage_totals, :input_tokens, 0),
        output_tokens: Map.get(usage_totals, :output_tokens, 0),
        total_tokens: Map.get(usage_totals, :total_tokens, 0)
      },
      log_hints: %{
        symphony_log_file: log_file,
        workspace_path: workspace_path,
        session_id: session_id,
        issue_identifier: issue_identifier
      }
    }
  end

  defp outcome_label(outcome) when is_atom(outcome), do: Atom.to_string(outcome)
  defp outcome_label(outcome) when is_binary(outcome), do: outcome
  defp outcome_label(_outcome), do: "unknown"

  defp runs_summary_payload(runs) when is_list(runs) do
    Enum.reduce(runs, %{total: 0, running: 0, success: 0, failed: 0, stalled: 0, canceled: 0}, fn run, acc ->
      acc = Map.update!(acc, :total, &(&1 + 1))

      case run.outcome do
        "running" -> Map.update!(acc, :running, &(&1 + 1))
        "success" -> Map.update!(acc, :success, &(&1 + 1))
        "failed" -> Map.update!(acc, :failed, &(&1 + 1))
        "stalled" -> Map.update!(acc, :stalled, &(&1 + 1))
        "canceled" -> Map.update!(acc, :canceled, &(&1 + 1))
        _ -> acc
      end
    end)
  end

  defp cost_summary_payload(runs) when is_list(runs) do
    by_agent =
      runs
      |> Enum.group_by(& &1.agent_kind)
      |> Enum.map(fn {agent_kind, grouped_runs} ->
        total_tokens = Enum.reduce(grouped_runs, 0, &(&1.tokens.total_tokens + &2))
        input_tokens = Enum.reduce(grouped_runs, 0, &(&1.tokens.input_tokens + &2))
        output_tokens = Enum.reduce(grouped_runs, 0, &(&1.tokens.output_tokens + &2))
        run_count = length(grouped_runs)
        completed_count = Enum.count(grouped_runs, &(&1.outcome != "running"))

        %{
          agent_kind: agent_kind,
          run_count: run_count,
          completed_count: completed_count,
          input_tokens: input_tokens,
          output_tokens: output_tokens,
          total_tokens: total_tokens,
          average_total_tokens_per_run: if(run_count > 0, do: total_tokens / run_count, else: 0.0),
          estimated_cost_usd: nil
        }
      end)
      |> Enum.sort_by(&{&1.agent_kind})

    top_runs =
      runs
      |> Enum.sort_by(&{-&1.tokens.total_tokens, &1.id})
      |> Enum.take(10)

    %{
      by_agent: by_agent,
      top_runs: top_runs,
      totals: %{
        run_count: length(runs),
        total_tokens: Enum.reduce(runs, 0, &(&1.tokens.total_tokens + &2)),
        estimated_cost_usd: nil
      }
    }
  end

  defp retries_payload(runs) when is_list(runs) do
    runs
    |> Enum.group_by(& &1.issue_id)
    |> Enum.map(fn {_issue_id, issue_runs} ->
      latest_run =
        issue_runs
        |> Enum.sort_by(&{&1.started_at || "", &1.id}, :desc)
        |> List.first()

      %{
        issue_id: latest_run.issue_id,
        issue_identifier: latest_run.issue_identifier,
        issue_title: latest_run.issue_title,
        attempts: length(issue_runs),
        latest_outcome: latest_run.outcome,
        latest_failure_reason: latest_run.failure_reason,
        total_tokens: Enum.reduce(issue_runs, 0, &(&1.tokens.total_tokens + &2)),
        latest_run_id: latest_run.id
      }
    end)
    |> Enum.filter(&(&1.attempts > 1))
    |> Enum.sort_by(&{-&1.attempts, -&1.total_tokens, &1.issue_identifier})
  end

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
