defmodule SymphonyElixirWeb.BarrierController do
  @moduledoc """
  HTTP endpoint for the Claude MCP sidecar to call into the orchestrator barrier.

  When a Claude agent's MCP sidecar detects a state-transition mutation in an
  ensemble run, it POSTs here instead of calling Linear directly. This delegates
  to the same `{:barrier_register, ...}` GenServer call that the Codex path uses.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixirWeb.Endpoint

  @spec check(Conn.t(), map()) :: Conn.t()
  def check(conn, %{"issue_id" => issue_id, "slot_index" => slot_index, "query" => query, "variables" => variables}) do
    case GenServer.call(
           orchestrator(),
           {:barrier_register, issue_id, slot_index, query, variables}
         ) do
      {:executed, response, ensemble_state} ->
        result =
          SymphonyElixir.ToolServer.inject_barrier_metadata(
            response,
            :executed,
            slot_index,
            issue_id,
            ensemble_state
          )

        json(conn, result)

      {:deferred, ensemble_state} ->
        synthetic = %{"data" => %{"issueUpdate" => %{"success" => true}}}

        result =
          SymphonyElixir.ToolServer.inject_barrier_metadata(
            synthetic,
            :deferred,
            slot_index,
            issue_id,
            ensemble_state
          )

        json(conn, result)

      {:error, reason} ->
        conn
        |> put_status(500)
        |> json(%{"error" => inspect(reason)})
    end
  end

  def check(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{"error" => "Missing required parameters: issue_id, slot_index, query, variables"})
  end

  defp orchestrator do
    Endpoint.config(:orchestrator) || SymphonyElixir.Orchestrator
  end
end
