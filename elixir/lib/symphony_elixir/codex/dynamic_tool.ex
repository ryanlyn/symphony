defmodule SymphonyElixir.Codex.DynamicTool do
  @moduledoc """
  Executes client-side tool calls requested by Codex app-server turns.
  """

  alias SymphonyElixir.Tools

  @spec execute(String.t() | nil, term(), keyword()) :: map()
  def execute(tool, arguments, opts \\ []) do
    case Tools.execute(tool, arguments, opts) do
      {:ok, %{success: success, payload: payload}} ->
        dynamic_tool_response(success, Tools.encode_payload(payload))

      {:error, payload} ->
        payload =
          if tool in Tools.supported_tool_names() do
            payload
          else
            %{
              "error" => %{
                "message" => "Unsupported dynamic tool: #{inspect(tool)}.",
                "supportedTools" => Tools.supported_tool_names()
              }
            }
          end

        dynamic_tool_response(false, Tools.encode_payload(payload))
    end
  end

  @spec tool_specs() :: [map()]
  def tool_specs, do: Tools.tool_specs()

  defp dynamic_tool_response(success, output) when is_boolean(success) and is_binary(output) do
    %{
      "success" => success,
      "output" => output,
      "contentItems" => [
        %{
          "type" => "inputText",
          "text" => output
        }
      ]
    }
  end
end
