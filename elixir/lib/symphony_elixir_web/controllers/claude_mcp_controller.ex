defmodule SymphonyElixirWeb.ClaudeMcpController do
  @moduledoc false

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.Claude.{McpAuth, McpServer}

  @spec handle(Conn.t(), map()) :: Conn.t()
  def handle(conn, _params) do
    with :ok <- authorize(conn),
         {:ok, response} <- McpServer.handle_request(conn.body_params, []) do
      case response do
        :no_content ->
          send_resp(conn, 204, "")

        payload ->
          json(conn, payload)
      end
    else
      :error ->
        conn
        |> put_status(401)
        |> json(%{
          "error" => %{
            "code" => "unauthorized",
            "message" => "Missing or invalid MCP bearer token"
          }
        })
    end
  end

  defp authorize(conn) do
    case Conn.get_req_header(conn, "authorization") do
      ["Bearer " <> token] -> McpAuth.validate_token(token)
      _ -> :error
    end
  end
end
