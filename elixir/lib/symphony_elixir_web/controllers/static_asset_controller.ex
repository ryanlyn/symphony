defmodule SymphonyElixirWeb.StaticAssetController do
  @moduledoc """
  Serves the dashboard's embedded CSS and JavaScript assets.
  """

  use Phoenix.Controller, formats: []

  alias Plug.Conn
  alias SymphonyElixirWeb.StaticAssets

  @spec show(Conn.t(), map()) :: Conn.t()
  def show(conn, _params), do: serve(conn, conn.request_path)

  defp serve(conn, path) do
    case StaticAssets.fetch(path) do
      {:ok, content_type, body} ->
        conn
        |> put_resp_content_type(content_type)
        |> put_resp_header("cache-control", "public, max-age=31536000")
        |> send_resp(200, body)

      :error ->
        send_resp(conn, 404, "Not Found")
    end
  end
end
