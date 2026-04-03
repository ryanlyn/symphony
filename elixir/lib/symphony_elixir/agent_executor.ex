defmodule SymphonyElixir.AgentExecutor do
  @moduledoc """
  Shared executor contract for agent backends.
  """

  @type session :: term()
  @type update :: %{optional(atom()) => term()}
  @type turn_result :: map()
  @type resume_metadata :: %{
          optional(:agent_kind) => String.t(),
          optional(:resume_id) => String.t() | nil,
          optional(:session_id) => String.t() | nil
        }

  @callback start_session(Path.t(), keyword()) :: {:ok, session()} | {:error, term()}
  @callback run_turn(session(), String.t(), map(), keyword()) ::
              {:ok, session(), turn_result()} | {:error, term()}
  @callback stop_session(session()) :: :ok
  @callback resume_metadata(session()) :: resume_metadata()

  @spec module_for_kind(String.t()) :: module()
  def module_for_kind("claude"), do: SymphonyElixir.Claude.Executor
  def module_for_kind(_kind), do: SymphonyElixir.Codex.Executor
end
