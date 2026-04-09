defmodule SymphonyElixir.Tracker do
  @moduledoc """
  Adapter boundary for issue tracker reads and writes.
  """

  alias SymphonyElixir.Config

  @callback fetch_candidate_issues() :: {:ok, [term()]} | {:error, term()}
  @callback fetch_issues_by_states([String.t()]) :: {:ok, [term()]} | {:error, term()}
  @callback fetch_issue_states_by_ids([String.t()]) :: {:ok, [term()]} | {:error, term()}
  @callback create_comment(String.t(), String.t()) :: :ok | {:error, term()}
  @callback update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}

  @spec fetch_candidate_issues() :: {:ok, [term()]} | {:error, term()}
  def fetch_candidate_issues do
    with {:ok, adapter} <- adapter_module() do
      adapter.fetch_candidate_issues()
    end
  end

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [term()]} | {:error, term()}
  def fetch_issues_by_states(states) do
    with {:ok, adapter} <- adapter_module() do
      adapter.fetch_issues_by_states(states)
    end
  end

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [term()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids) do
    with {:ok, adapter} <- adapter_module() do
      adapter.fetch_issue_states_by_ids(issue_ids)
    end
  end

  @spec create_comment(String.t(), String.t()) :: :ok | {:error, term()}
  def create_comment(issue_id, body) do
    with {:ok, adapter} <- adapter_module() do
      adapter.create_comment(issue_id, body)
    end
  end

  @spec update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}
  def update_issue_state(issue_id, state_name) do
    with {:ok, adapter} <- adapter_module() do
      adapter.update_issue_state(issue_id, state_name)
    end
  end

  @spec adapter() :: module()
  def adapter do
    case Config.settings!().tracker.kind do
      "memory" -> SymphonyElixir.Tracker.Memory
      _ -> SymphonyElixir.Linear.Adapter
    end
  end

  defp adapter_module do
    case Config.settings() do
      {:ok, settings} ->
        {:ok, adapter_for_kind(settings.tracker.kind)}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp adapter_for_kind("memory"), do: SymphonyElixir.Tracker.Memory
  defp adapter_for_kind(_kind), do: SymphonyElixir.Linear.Adapter
end
