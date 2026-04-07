defmodule SymphonyElixir.Claude.McpServer do
  @moduledoc false

  alias SymphonyElixir.Tools

  @server_name "symphony_linear"
  @protocol_version "2025-11-25"

  @spec server_name() :: String.t()
  def server_name, do: @server_name

  @spec handle_request(map(), keyword()) :: {:ok, map()} | {:ok, :no_content}
  def handle_request(%{"method" => "notifications/initialized"}, _opts), do: {:ok, :no_content}

  def handle_request(%{"method" => "initialize", "id" => request_id} = message, _opts) do
    params = Map.get(message, "params", %{})

    {:ok,
     %{
       "jsonrpc" => "2.0",
       "id" => request_id,
       "result" => %{
         "protocolVersion" => Map.get(params, "protocolVersion") || @protocol_version,
         "capabilities" => %{"tools" => %{}},
         "serverInfo" => %{"name" => "symphony-claude-mcp", "version" => "0.1.0"}
       }
     }}
  end

  def handle_request(%{"method" => "tools/list", "id" => request_id}, _opts) do
    {:ok,
     %{
       "jsonrpc" => "2.0",
       "id" => request_id,
       "result" => %{"tools" => Tools.tool_specs()}
     }}
  end

  def handle_request(%{"method" => "tools/call", "id" => request_id} = message, opts) do
    params = Map.get(message, "params", %{})
    tool_name = Map.get(params, "name")
    arguments = Map.get(params, "arguments") || %{}

    payload =
      case Tools.execute(tool_name, arguments, opts) do
        {:ok, %{success: success, payload: tool_payload}} ->
          %{
            "jsonrpc" => "2.0",
            "id" => request_id,
            "result" => %{
              "content" => [%{"type" => "text", "text" => Tools.encode_payload(tool_payload)}],
              "isError" => !success
            }
          }

        {:error, tool_payload} ->
          error_payload =
            if tool_name in Tools.supported_tool_names() do
              tool_payload
            else
              %{
                "error" => %{
                  "message" => "Unsupported tool: #{inspect(tool_name)}.",
                  "supportedTools" => Tools.supported_tool_names()
                }
              }
            end

          %{
            "jsonrpc" => "2.0",
            "id" => request_id,
            "result" => %{
              "content" => [%{"type" => "text", "text" => Tools.encode_payload(error_payload)}],
              "isError" => true
            }
          }
      end

    {:ok, payload}
  end

  def handle_request(%{"method" => method, "id" => request_id}, _opts) when is_binary(method) do
    {:ok,
     %{
       "jsonrpc" => "2.0",
       "id" => request_id,
       "error" => %{"code" => -32_601, "message" => "Method not found: #{method}"}
     }}
  end
end
