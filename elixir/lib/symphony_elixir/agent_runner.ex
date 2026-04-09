defmodule SymphonyElixir.AgentRunner do
  @moduledoc """
  Executes a single Linear issue in its workspace with the configured agent executor.
  """

  require Logger
  alias SymphonyElixir.{AgentResumeState, Config, Linear.Issue, PromptBuilder, Tracker, Workspace}
  alias SymphonyElixir.Config.Schema

  @dialyzer :no_match
  @worker_setup_timeout_grace_ms 1_000
  @workspace_create_stage "workspace.create_for_issue"
  @before_run_hook_stage "workspace.run_before_run_hook"
  @after_run_hook_stage "workspace.run_after_run_hook"

  @type worker_host :: String.t() | nil

  @spec run(map(), pid() | nil, keyword()) :: :ok | no_return()
  def run(issue, update_recipient \\ nil, opts \\ []) do
    settings =
      Keyword.get_lazy(opts, :runtime_settings, fn ->
        Config.settings_for_issue_state!(Map.get(issue, :state))
      end)

    agent_kind = settings.agent.kind
    # The orchestrator owns host retries so one worker lifetime never hops machines.
    worker_host = selected_worker_host(Keyword.get(opts, :worker_host), settings.worker.ssh_hosts)
    executor = executor_module(opts, agent_kind)
    slot_index = Keyword.get(opts, :slot_index, 0)
    ensemble_size = Keyword.get(opts, :ensemble_size, 1)

    Logger.info("Starting agent run for #{issue_context(issue)} agent_kind=#{agent_kind} worker_host=#{worker_host_for_log(worker_host)} slot=#{slot_index}/#{ensemble_size}")

    case run_on_worker_host(issue, update_recipient, opts, worker_host, executor, agent_kind) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.error("Agent run failed for #{issue_context(issue)}: #{inspect(reason)}")
        raise RuntimeError, "Agent run failed for #{issue_context(issue)}: #{inspect(reason)}"
    end
  end

  defp run_on_worker_host(issue, update_recipient, opts, worker_host, executor, agent_kind) do
    runtime_settings =
      Keyword.get_lazy(opts, :runtime_settings, fn ->
        Config.settings_for_issue_state!(Map.get(issue, :state))
      end)

    workspace_module = workspace_module(opts)
    slot_index = Keyword.get(opts, :slot_index, 0)
    ensemble_size = Keyword.get(opts, :ensemble_size, 1)
    workspace_create_timeout_ms = workspace_create_timeout_ms(opts, runtime_settings, agent_kind)
    hook_timeout_ms = hook_timeout_ms(opts, runtime_settings)

    Logger.info("Starting worker attempt for #{issue_context(issue)} agent_kind=#{agent_kind} worker_host=#{worker_host_for_log(worker_host)} slot=#{slot_index}/#{ensemble_size}")

    case run_setup_stage(@workspace_create_stage, workspace_create_timeout_ms, fn ->
           workspace_module.create_for_issue(issue, worker_host,
             slot_index: slot_index,
             ensemble_size: ensemble_size
           )
         end) do
      {:ok, workspace} ->
        send_worker_runtime_info(update_recipient, issue, worker_host, workspace, agent_kind, slot_index, ensemble_size)

        try do
          with :ok <-
                 run_setup_stage(@before_run_hook_stage, hook_timeout_ms, fn ->
                   workspace_module.run_before_run_hook(workspace, issue, worker_host)
                 end) do
            run_agent_turns(executor, workspace, issue, update_recipient, opts, worker_host)
          end
        after
          run_after_run_hook(workspace_module, workspace, issue, worker_host, hook_timeout_ms)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp run_after_run_hook(workspace_module, workspace, issue, worker_host, timeout_ms) do
    case run_setup_stage(@after_run_hook_stage, timeout_ms, fn ->
           workspace_module.run_after_run_hook(workspace, issue, worker_host)
         end) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("Ignoring after_run hook failure for #{issue_context(issue)} worker_host=#{worker_host_for_log(worker_host)}: #{inspect(reason)}")

        :ok
    end
  end

  defp run_setup_stage(stage_name, timeout_ms, fun)
       when is_binary(stage_name) and is_integer(timeout_ms) and timeout_ms > 0 and is_function(fun, 0) do
    task = Task.Supervisor.async_nolink(SymphonyElixir.TaskSupervisor, fun)

    case Task.yield(task, timeout_ms) do
      {:ok, result} ->
        result

      {:exit, reason} ->
        {:error, {:agent_runner_setup_crashed, stage_name, reason}}

      nil ->
        Task.shutdown(task, 0)
        Task.shutdown(task, :brutal_kill)
        {:error, {:agent_runner_timeout, stage_name, timeout_ms}}
    end
  end

  defp executor_message_handler(recipient, issue, slot_index),
    do: &send_agent_update(recipient, issue, &1, slot_index)

  defp send_agent_update(recipient, %Issue{id: issue_id}, %{agent_kind: _agent_kind} = message, slot_index)
       when is_binary(issue_id) and is_pid(recipient) do
    send(recipient, {:agent_worker_update, issue_id, Map.put(message, :slot_index, slot_index)})
    :ok
  end

  defp send_agent_update(_recipient, _issue, _message, _slot_index), do: :ok

  defp send_worker_runtime_info(recipient, %Issue{id: issue_id}, worker_host, workspace, agent_kind, slot_index, ensemble_size)
       when is_binary(issue_id) and is_pid(recipient) and is_binary(workspace) do
    send(
      recipient,
      {:worker_runtime_info, issue_id,
       %{
         agent_kind: agent_kind,
         worker_host: worker_host,
         workspace_path: workspace,
         slot_index: slot_index,
         ensemble_size: ensemble_size
       }}
    )

    :ok
  end

  defp send_worker_runtime_info(_recipient, _issue, _worker_host, _workspace, _agent_kind, _slot_index, _ensemble_size), do: :ok

  defp run_agent_turns(executor, workspace, issue, update_recipient, opts, worker_host) do
    runtime_settings = initial_runtime_settings(issue, opts)

    max_turns = resolved_max_turns(opts, runtime_settings)
    issue_state_fetcher = Keyword.get(opts, :issue_state_fetcher, &Tracker.fetch_issue_states_by_ids/1)
    slot_index = Keyword.get(opts, :slot_index, 0)
    ensemble_size = Keyword.get(opts, :ensemble_size, 1)

    ctx = %{
      executor: executor,
      workspace: workspace,
      update_recipient: update_recipient,
      opts: runner_opts(opts, runtime_settings, slot_index, ensemble_size, issue.id),
      issue_state_fetcher: issue_state_fetcher,
      runtime_settings: runtime_settings,
      max_turns: max_turns,
      worker_host: worker_host
    }

    with {:ok, session} <-
           start_session(
             executor,
             workspace,
             issue,
             worker_host,
             runtime_settings: runtime_settings,
             slot_index: slot_index,
             ensemble_size: ensemble_size
           ) do
      case do_run_agent_turns(ctx, session, issue, 1) do
        {:ok, final_session} ->
          executor.stop_session(final_session)
          :ok

        {:error, reason, final_session} ->
          executor.stop_session(final_session)
          {:error, reason}
      end
    end
  end

  defp do_run_agent_turns(ctx, session, issue, turn_number) do
    %{
      executor: executor,
      workspace: workspace,
      update_recipient: update_recipient,
      opts: opts,
      issue_state_fetcher: issue_state_fetcher,
      max_turns: max_turns,
      worker_host: worker_host
    } = ctx

    prompt = build_turn_prompt(issue, opts, turn_number, max_turns)

    case executor.run_turn(
           session,
           prompt,
           issue,
           on_message: executor_message_handler(update_recipient, issue, Keyword.get(opts, :slot_index, 0))
         ) do
      {:ok, updated_session, turn_result} ->
        persist_resume_state(workspace, worker_host, issue, executor.resume_metadata(updated_session))

        Logger.info("Completed agent run for #{issue_context(issue)} session_id=#{turn_result[:session_id]} workspace=#{workspace} turn=#{turn_number}/#{max_turns}")

        case continue_with_issue?(issue, issue_state_fetcher) do
          {:continue, refreshed_issue} ->
            continue_active_issue(ctx, updated_session, refreshed_issue, turn_number)

          {:done, _refreshed_issue} ->
            {:ok, updated_session}

          {:error, reason} ->
            {:error, reason, updated_session}
        end

      {:error, reason} ->
        {:error, reason, session}
    end
  end

  defp build_turn_prompt(issue, opts, 1, _max_turns), do: PromptBuilder.build_prompt(issue, opts)

  defp build_turn_prompt(_issue, _opts, turn_number, max_turns) do
    """
    Continuation guidance:

    - The previous agent turn completed normally, but the Linear issue is still in an active state.
    - This is continuation turn ##{turn_number} of #{max_turns} for the current agent run.
    - Resume from the current workspace and workpad state instead of restarting from scratch.
    - The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
    - Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
    """
  end

  defp continue_with_issue?(%Issue{id: issue_id} = issue, issue_state_fetcher) when is_binary(issue_id) do
    case issue_state_fetcher.([issue_id]) do
      {:ok, [%Issue{} = refreshed_issue | _]} ->
        if active_issue_state?(refreshed_issue.state) do
          {:continue, refreshed_issue}
        else
          {:done, refreshed_issue}
        end

      {:ok, []} ->
        {:done, issue}

      {:error, reason} ->
        {:error, {:issue_state_refresh_failed, reason}}
    end
  end

  defp continue_with_issue?(issue, _issue_state_fetcher), do: {:done, issue}

  defp continue_active_issue(ctx, updated_session, refreshed_issue, turn_number) do
    case refreshed_continuation_ctx(ctx, refreshed_issue) do
      {:continue, %{max_turns: refreshed_max_turns} = next_ctx}
      when turn_number < refreshed_max_turns ->
        Logger.info("Continuing agent run for #{issue_context(refreshed_issue)} after normal turn completion turn=#{turn_number}/#{next_ctx.max_turns}")

        do_run_agent_turns(next_ctx, updated_session, refreshed_issue, turn_number + 1)

      {:continue, next_ctx} ->
        Logger.info("Reached agent.max_turns for #{issue_context(refreshed_issue)} with issue still active; returning control to orchestrator turn=#{turn_number}/#{next_ctx.max_turns}")

        {:ok, updated_session}

      {:restart, reason} ->
        Logger.info("Ending agent run for #{issue_context(refreshed_issue)} after state refresh so the orchestrator can restart with updated runtime settings: #{reason}")
        {:ok, updated_session}
    end
  end

  defp initial_runtime_settings(issue, opts) do
    Keyword.get_lazy(opts, :runtime_settings, fn -> resolve_runtime_settings(issue, opts) end)
  end

  defp resolve_runtime_settings(%Issue{} = issue, opts) do
    Keyword.get(opts, :runtime_settings_resolver, &Config.settings_for_issue_state!/1).(issue.state)
  end

  defp resolved_max_turns(opts, %Schema{} = runtime_settings) do
    Keyword.get(opts, :max_turns, runtime_settings.agent.max_turns)
  end

  defp runner_opts(opts, runtime_settings, slot_index, ensemble_size, issue_id) do
    Keyword.merge(
      opts,
      runtime_settings: runtime_settings,
      slot_index: slot_index,
      ensemble_size: ensemble_size,
      issue_id: issue_id
    )
  end

  defp refreshed_continuation_ctx(%{opts: opts, runtime_settings: runtime_settings} = ctx, %Issue{} = refreshed_issue) do
    refreshed_runtime_settings = resolve_runtime_settings(refreshed_issue, opts)
    refreshed_max_turns = resolved_max_turns(opts, refreshed_runtime_settings)

    if continuation_requires_restart?(runtime_settings, refreshed_runtime_settings) do
      {:restart, continuation_restart_reason(runtime_settings, refreshed_runtime_settings)}
    else
      {:continue,
       %{
         ctx
         | runtime_settings: refreshed_runtime_settings,
           max_turns: refreshed_max_turns,
           opts:
             runner_opts(
               opts,
               refreshed_runtime_settings,
               Keyword.get(opts, :slot_index, 0),
               Keyword.get(opts, :ensemble_size, 1),
               Keyword.get(opts, :issue_id, refreshed_issue.id)
             )
       }}
    end
  end

  defp continuation_requires_restart?(%Schema{} = current_runtime, %Schema{} = refreshed_runtime) do
    current_runtime.agent.kind != refreshed_runtime.agent.kind or
      continuation_runtime_profile(current_runtime) != continuation_runtime_profile(refreshed_runtime)
  end

  defp continuation_runtime_profile(%Schema{} = runtime_settings) do
    case runtime_settings.agent.kind do
      "claude" ->
        %{agent_kind: "claude", claude: runtime_settings.claude}

      agent_kind ->
        %{agent_kind: agent_kind, codex: runtime_settings.codex}
    end
  end

  defp continuation_restart_reason(%Schema{} = current_runtime, %Schema{} = refreshed_runtime) do
    case {current_runtime.agent.kind, refreshed_runtime.agent.kind} do
      {current_kind, refreshed_kind} when current_kind != refreshed_kind ->
        "agent.kind changed from #{inspect(current_kind)} to #{inspect(refreshed_kind)}"

      {agent_kind, _same_kind} ->
        "#{agent_kind} runtime profile changed"
    end
  end

  defp start_session(executor, workspace, %Issue{} = issue, worker_host, opts) do
    runtime_settings = Keyword.fetch!(opts, :runtime_settings)
    agent_kind = runtime_settings.agent.kind
    resume_metadata = resume_metadata(workspace, issue, worker_host, agent_kind)
    slot_opts = Keyword.take(opts, [:slot_index, :ensemble_size])

    case executor.start_session(
           workspace,
           [
             issue: issue,
             worker_host: worker_host,
             resume_metadata: resume_metadata,
             issue_id: issue.id,
             runtime_settings: runtime_settings
           ] ++
             slot_opts
         ) do
      {:ok, session} ->
        persist_resume_state(workspace, worker_host, issue, executor.resume_metadata(session))
        {:ok, session}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp resume_metadata(workspace, %Issue{} = issue, worker_host, agent_kind) do
    case AgentResumeState.read(workspace, worker_host) do
      {:ok, resume_state} ->
        if resume_state_matches_issue?(resume_state, issue, workspace, worker_host, agent_kind) do
          Logger.info("Resuming agent context for #{issue_context(issue)} agent_kind=#{resume_state.agent_kind} resume_id=#{resume_state.resume_id}")

          %{
            agent_kind: resume_state.agent_kind,
            resume_id: resume_state.resume_id,
            session_id: resume_state.session_id
          }
        else
          %{}
        end

      :missing ->
        %{}

      {:error, reason} ->
        Logger.warning("Failed to read resume state for #{issue_context(issue)}: #{inspect(reason)}; not resuming thread")
        %{}
    end
  end

  @dialyzer {:no_match, [persist_resume_state: 4]}
  defp persist_resume_state(workspace, worker_host, %Issue{} = issue, resume_metadata)
       when is_binary(workspace) and is_map(resume_metadata) do
    resume_id = Map.get(resume_metadata, :resume_id)

    if is_binary(workspace) and is_binary(resume_id) and resume_id != "" do
      agent_kind = Map.get(resume_metadata, :agent_kind)

      attrs = %{
        agent_kind: agent_kind || Map.get(resume_metadata, "agent_kind"),
        resume_id: resume_id,
        session_id: Map.get(resume_metadata, :session_id),
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        issue_state: issue.state,
        thread_id: Map.get(resume_metadata, :thread_id),
        workspace_path: workspace,
        worker_host: worker_host,
        updated_at: DateTime.utc_now() |> DateTime.to_iso8601()
      }

      case AgentResumeState.write(workspace, attrs, worker_host) do
        :ok ->
          :ok

        {:error, reason} ->
          Logger.warning("Failed to persist resume state for #{issue_context(issue)}: #{inspect(reason)}")
          :ok
      end
    else
      :ok
    end
  end

  defp persist_resume_state(_workspace, _worker_host, _issue, _resume_metadata), do: :ok

  defp resume_state_matches_issue?(resume_state, %Issue{} = issue, workspace, worker_host, agent_kind)
       when is_map(resume_state) do
    stored_value_matches?(resume_state.agent_kind, agent_kind) and
      stored_value_matches?(resume_state.issue_id, issue.id) and
      stored_value_matches?(resume_state.issue_identifier, issue.identifier) and
      stored_value_matches?(resume_state.issue_state, issue.state) and
      stored_value_matches?(resume_state.workspace_path, workspace) and
      worker_host_matches?(resume_state.worker_host, worker_host)
  end

  defp stored_value_matches?(nil, _current_value), do: true
  defp stored_value_matches?(stored_value, current_value), do: stored_value == current_value

  defp worker_host_matches?(nil, nil), do: true
  defp worker_host_matches?(nil, _worker_host), do: false
  defp worker_host_matches?(stored_worker_host, worker_host), do: stored_worker_host == worker_host

  defp active_issue_state?(state_name) when is_binary(state_name) do
    normalized_state = Schema.normalize_issue_state(state_name)

    Config.settings!().tracker.active_states
    |> Enum.any?(fn active_state -> Schema.normalize_issue_state(active_state) == normalized_state end)
  end

  defp active_issue_state?(_state_name), do: false

  defp executor_module(opts, agent_kind) do
    Keyword.get(opts, :executor, SymphonyElixir.AgentExecutor.module_for_kind(agent_kind))
  end

  defp workspace_module(opts) do
    Keyword.get(opts, :workspace_module, Workspace)
  end

  defp workspace_create_timeout_ms(opts, %Schema{} = runtime_settings, agent_kind) do
    case Keyword.get(opts, :workspace_create_timeout_ms) || Keyword.get(opts, :worker_setup_timeout_ms) do
      timeout_ms when is_integer(timeout_ms) and timeout_ms > 0 ->
        timeout_ms

      _ ->
        case agent_kind do
          "claude" -> runtime_settings.claude.stall_timeout_ms
          _ -> runtime_settings.codex.stall_timeout_ms
        end
    end
  end

  defp hook_timeout_ms(opts, %Schema{} = runtime_settings) do
    case Keyword.get(opts, :hook_timeout_ms) || Keyword.get(opts, :worker_setup_timeout_ms) do
      timeout_ms when is_integer(timeout_ms) and timeout_ms > 0 ->
        timeout_ms

      _ ->
        runtime_settings.hooks.timeout_ms + @worker_setup_timeout_grace_ms
    end
  end

  defp selected_worker_host(nil, []), do: nil

  defp selected_worker_host(preferred_host, configured_hosts) when is_list(configured_hosts) do
    hosts =
      configured_hosts
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == ""))
      |> Enum.uniq()

    case preferred_host do
      host when is_binary(host) and host != "" -> host
      _ when hosts == [] -> nil
      _ -> List.first(hosts)
    end
  end

  defp worker_host_for_log(nil), do: "local"
  defp worker_host_for_log(worker_host), do: worker_host

  defp issue_context(%Issue{id: issue_id, identifier: identifier}) do
    "issue_id=#{issue_id} issue_identifier=#{identifier}"
  end
end
