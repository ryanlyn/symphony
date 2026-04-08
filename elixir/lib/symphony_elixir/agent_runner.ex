defmodule SymphonyElixir.AgentRunner do
  @moduledoc """
  Executes a single Linear issue in its workspace with the configured agent executor.
  """

  require Logger
  alias SymphonyElixir.{AgentResumeState, Config, Linear.Issue, PromptBuilder, Tracker, Workspace}

  @dialyzer :no_match

  @type worker_host :: String.t() | nil

  @spec run(map(), pid() | nil, keyword()) :: :ok | no_return()
  def run(issue, update_recipient \\ nil, opts \\ []) do
    settings = Keyword.get(opts, :settings, Config.settings!())
    agent_kind = settings.agent.kind
    # The orchestrator owns host retries so one worker lifetime never hops machines.
    worker_host = selected_worker_host(Keyword.get(opts, :worker_host), settings.worker.ssh_hosts)
    executor = executor_module(opts, agent_kind)
    slot_index = Keyword.get(opts, :slot_index, 0)
    ensemble_size = Keyword.get(opts, :ensemble_size, 1)

    Logger.info("Starting agent run for #{issue_context(issue)} agent_kind=#{agent_kind} worker_host=#{worker_host_for_log(worker_host)} slot=#{slot_index}/#{ensemble_size}")

    case run_on_worker_host(issue, update_recipient, opts, worker_host, executor, agent_kind, settings) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.error("Agent run failed for #{issue_context(issue)}: #{inspect(reason)}")
        raise RuntimeError, "Agent run failed for #{issue_context(issue)}: #{inspect(reason)}"
    end
  end

  defp run_on_worker_host(issue, update_recipient, opts, worker_host, executor, agent_kind, settings) do
    slot_index = Keyword.get(opts, :slot_index, 0)
    ensemble_size = Keyword.get(opts, :ensemble_size, 1)

    Logger.info("Starting worker attempt for #{issue_context(issue)} agent_kind=#{agent_kind} worker_host=#{worker_host_for_log(worker_host)} slot=#{slot_index}/#{ensemble_size}")

    case Workspace.create_for_issue(issue, worker_host, slot_index: slot_index) do
      {:ok, workspace} ->
        send_worker_runtime_info(update_recipient, issue, worker_host, workspace, agent_kind, slot_index, ensemble_size)

        try do
          with :ok <- Workspace.run_before_run_hook(workspace, issue, worker_host) do
            run_agent_turns(executor, workspace, issue, update_recipient, opts, worker_host, settings)
          end
        after
          Workspace.run_after_run_hook(workspace, issue, worker_host)
        end

      {:error, reason} ->
        {:error, reason}
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

  defp run_agent_turns(executor, workspace, issue, update_recipient, opts, worker_host, settings) do
    max_turns = Keyword.get(opts, :max_turns, settings.agent.max_turns)

    issue_state_fetcher =
      Keyword.get(opts, :issue_state_fetcher, fn issue_ids ->
        Tracker.fetch_issue_states_by_ids(issue_ids, settings)
      end)

    slot_index = Keyword.get(opts, :slot_index, 0)
    ensemble_size = Keyword.get(opts, :ensemble_size, 1)
    prompt_opts = Keyword.delete(opts, :settings)

    ctx = %{
      executor: executor,
      workspace: workspace,
      update_recipient: update_recipient,
      opts:
        Keyword.merge(
          prompt_opts,
          slot_index: slot_index,
          ensemble_size: ensemble_size,
          issue_id: issue.id
        ),
      issue_state_fetcher: issue_state_fetcher,
      max_turns: max_turns,
      worker_host: worker_host,
      settings: settings
    }

    with {:ok, session} <-
           start_session(
             executor,
             workspace,
             issue,
             worker_host,
             settings,
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
      worker_host: worker_host,
      settings: settings
    } = ctx

    prompt = build_turn_prompt(issue, opts, turn_number, max_turns)

    case executor.run_turn(
           session,
           prompt,
           issue,
           on_message: executor_message_handler(update_recipient, issue, Keyword.get(opts, :slot_index, 0))
         ) do
      {:ok, updated_session, turn_result} ->
        persist_resume_state(workspace, worker_host, issue, executor.resume_metadata(updated_session), settings)

        Logger.info("Completed agent run for #{issue_context(issue)} session_id=#{turn_result[:session_id]} workspace=#{workspace} turn=#{turn_number}/#{max_turns}")

        case continue_with_issue?(issue, issue_state_fetcher, settings) do
          {:continue, refreshed_issue} when turn_number < max_turns ->
            Logger.info("Continuing agent run for #{issue_context(refreshed_issue)} after normal turn completion turn=#{turn_number}/#{max_turns}")

            do_run_agent_turns(ctx, updated_session, refreshed_issue, turn_number + 1)

          {:continue, refreshed_issue} ->
            Logger.info("Reached agent.max_turns for #{issue_context(refreshed_issue)} with issue still active; returning control to orchestrator")

            {:ok, updated_session}

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

  defp continue_with_issue?(%Issue{id: issue_id} = issue, issue_state_fetcher, settings)
       when is_binary(issue_id) do
    case issue_state_fetcher.([issue_id]) do
      {:ok, [%Issue{} = refreshed_issue | _]} ->
        if active_issue_state?(refreshed_issue.state, settings) do
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

  defp continue_with_issue?(issue, _issue_state_fetcher, _settings), do: {:done, issue}

  defp start_session(executor, workspace, %Issue{} = issue, worker_host, settings, opts) do
    resume_metadata = resume_metadata(workspace, issue, worker_host, settings.agent.kind)
    slot_opts = Keyword.take(opts, [:slot_index, :ensemble_size])

    case executor.start_session(
           workspace,
           [issue: issue, worker_host: worker_host, resume_metadata: resume_metadata, issue_id: issue.id] ++
             slot_opts
         ) do
      {:ok, session} ->
        persist_resume_state(workspace, worker_host, issue, executor.resume_metadata(session), settings)
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

  defp persist_resume_state(workspace, worker_host, %Issue{} = issue, resume_metadata, settings)
       when is_binary(workspace) and is_map(resume_metadata) do
    resume_id = Map.get(resume_metadata, :resume_id)

    if is_binary(workspace) and is_binary(resume_id) and resume_id != "" do
      attrs = %{
        agent_kind: Map.get(resume_metadata, :agent_kind) || settings.agent.kind,
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

  defp persist_resume_state(_workspace, _worker_host, _issue, _resume_metadata, _settings), do: :ok

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

  defp active_issue_state?(state_name, settings) when is_binary(state_name) do
    normalized_state = normalize_issue_state(state_name)

    settings.tracker.active_states
    |> Enum.any?(fn active_state -> normalize_issue_state(active_state) == normalized_state end)
  end

  defp active_issue_state?(_state_name, _settings), do: false

  defp executor_module(opts, agent_kind) do
    Keyword.get(opts, :executor, SymphonyElixir.AgentExecutor.module_for_kind(agent_kind))
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

  defp normalize_issue_state(state_name) when is_binary(state_name) do
    state_name
    |> String.trim()
    |> String.downcase()
  end

  defp issue_context(%Issue{id: issue_id, identifier: identifier}) do
    "issue_id=#{issue_id} issue_identifier=#{identifier}"
  end
end
