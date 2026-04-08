defmodule SymphonyElixir.Tracker do
  @moduledoc """
  Adapter boundary for issue tracker reads and writes.
  """

  alias SymphonyElixir.Config
  alias SymphonyElixir.Config.Schema

  @callback fetch_candidate_issues() :: {:ok, [term()]} | {:error, term()}
  @callback fetch_candidate_issues(Schema.t()) :: {:ok, [term()]} | {:error, term()}
  @callback fetch_issues_by_states([String.t()]) :: {:ok, [term()]} | {:error, term()}
  @callback fetch_issues_by_states([String.t()], Schema.t()) :: {:ok, [term()]} | {:error, term()}
  @callback fetch_issue_states_by_ids([String.t()]) :: {:ok, [term()]} | {:error, term()}
  @callback fetch_issue_states_by_ids([String.t()], Schema.t()) :: {:ok, [term()]} | {:error, term()}
  @callback create_comment(String.t(), String.t()) :: :ok | {:error, term()}
  @callback update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}

  @spec fetch_candidate_issues() :: {:ok, [term()]} | {:error, term()}
  def fetch_candidate_issues do
    adapter().fetch_candidate_issues()
  end

  @spec fetch_candidate_issues(Schema.t()) :: {:ok, [term()]} | {:error, term()}
  def fetch_candidate_issues(%Schema{} = settings) do
    adapter(settings).fetch_candidate_issues(settings)
  end

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [term()]} | {:error, term()}
  def fetch_issues_by_states(states) do
    adapter().fetch_issues_by_states(states)
  end

  @spec fetch_issues_by_states([String.t()], Schema.t()) :: {:ok, [term()]} | {:error, term()}
  def fetch_issues_by_states(states, %Schema{} = settings) do
    adapter(settings).fetch_issues_by_states(states, settings)
  end

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [term()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids) do
    adapter().fetch_issue_states_by_ids(issue_ids)
  end

  @spec fetch_issue_states_by_ids([String.t()], Schema.t()) :: {:ok, [term()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids, %Schema{} = settings) do
    adapter(settings).fetch_issue_states_by_ids(issue_ids, settings)
  end

  @spec create_comment(String.t(), String.t()) :: :ok | {:error, term()}
  def create_comment(issue_id, body) do
    adapter().create_comment(issue_id, body)
  end

  @spec update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}
  def update_issue_state(issue_id, state_name) do
    adapter().update_issue_state(issue_id, state_name)
  end

  @spec adapter() :: module()
  def adapter do
    adapter(Config.settings!())
  end

  @spec adapter(Schema.t()) :: module()
  def adapter(%Schema{} = settings) do
    case settings.tracker.kind do
      "memory" -> SymphonyElixir.Tracker.Memory
      _ -> SymphonyElixir.Linear.Adapter
    end
  end
end
