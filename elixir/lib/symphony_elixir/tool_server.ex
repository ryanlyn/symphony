defmodule SymphonyElixir.ToolServer do
  @moduledoc """
  Unified linear_graphql handler for both Claude and Codex executors.
  Intercepts state-transition mutations and gates them through the
  orchestrator barrier for ensemble coordination.
  """

  alias SymphonyElixir.Linear.Client

  @spec handle_linear_graphql(String.t(), map(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def handle_linear_graphql(query, variables, opts)
      when is_binary(query) and is_map(variables) and is_list(opts) do
    if state_transition_mutation?(query, variables) do
      handle_state_transition(query, variables, opts)
    else
      execute_passthrough(query, variables, opts)
    end
  end

  @spec state_transition_mutation?(String.t(), map()) :: boolean()
  def state_transition_mutation?(query, variables)
      when is_binary(query) and is_map(variables) do
    String.contains?(query, "issueUpdate") and has_state_id?(variables)
  end

  @spec inject_barrier_metadata(map(), :deferred | :executed, non_neg_integer(), String.t(), map()) :: map()
  def inject_barrier_metadata(response, status, slot_index, _issue_id, ensemble_state)
      when is_map(response) and is_atom(status) and is_integer(slot_index) and is_map(ensemble_state) do
    completed_slots = ensemble_state.completed_slots |> MapSet.to_list() |> Enum.sort()
    ensemble_size = ensemble_state.ensemble_size

    barrier = %{
      "status" => Atom.to_string(status),
      "slot" => slot_index,
      "ensemble_size" => ensemble_size,
      "completed_slots" => completed_slots,
      "message" => barrier_message(status, ensemble_size)
    }

    Map.put(response, "_symphony_barrier", barrier)
  end

  # ── Private ───────────────────────────────────────────────────────────

  defp has_state_id?(variables) do
    Map.has_key?(variables, "stateId") or
      (is_map(variables["input"]) and Map.has_key?(variables["input"], "stateId"))
  end

  defp handle_state_transition(query, variables, opts) do
    ensemble_size = Keyword.fetch!(opts, :ensemble_size)

    if ensemble_size <= 1 do
      handle_solo_state_transition(query, variables, opts)
    else
      handle_ensemble_state_transition(query, variables, opts)
    end
  end

  defp handle_solo_state_transition(query, variables, opts) do
    slot_index = Keyword.fetch!(opts, :slot_index)
    issue_id = Keyword.fetch!(opts, :issue_id)

    case execute_passthrough(query, variables, opts) do
      {:ok, response} ->
        ensemble_state = %{
          completed_slots: MapSet.new([slot_index]),
          ensemble_size: 1
        }

        {:ok, inject_barrier_metadata(response, :executed, slot_index, issue_id, ensemble_state)}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp handle_ensemble_state_transition(query, variables, opts) do
    slot_index = Keyword.fetch!(opts, :slot_index)
    issue_id = Keyword.fetch!(opts, :issue_id)

    case GenServer.call(
           SymphonyElixir.Orchestrator,
           {:barrier_register, issue_id, slot_index, query, variables}
         ) do
      {:executed, response, ensemble_state} ->
        {:ok, inject_barrier_metadata(response, :executed, slot_index, issue_id, ensemble_state)}

      {:deferred, ensemble_state} ->
        synthetic = %{"data" => %{"issueUpdate" => %{"success" => true}}}
        {:ok, inject_barrier_metadata(synthetic, :deferred, slot_index, issue_id, ensemble_state)}
    end
  end

  defp execute_passthrough(query, variables, opts) do
    linear_client = Keyword.get(opts, :linear_client, &Client.graphql/3)
    linear_client.(query, variables, [])
  end

  defp barrier_message(:deferred, ensemble_size) do
    "State transition registered. Will be applied when all #{ensemble_size} slots complete."
  end

  defp barrier_message(:executed, ensemble_size) do
    "State transition executed. All #{ensemble_size} slots completed."
  end
end
