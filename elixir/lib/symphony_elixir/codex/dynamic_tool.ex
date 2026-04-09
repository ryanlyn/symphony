defmodule SymphonyElixir.Codex.DynamicTool do
  @moduledoc """
  Executes client-side tool calls requested by Codex app-server turns.
  """

  alias SymphonyElixir.Tools

  @spec execute(String.t() | nil, term(), keyword()) :: map()
  def execute(tool, arguments, opts \\ [])

  def execute(nil, _arguments, _opts) do
    dynamic_tool_response(false, Tools.encode_payload(missing_tool_payload()))
  end

  def execute(tool, arguments, opts) do
    case Tools.execute(tool, arguments, opts) do
      {:ok, %{success: success, payload: payload}} ->
        dynamic_tool_response(success, Tools.encode_payload(payload))

      {:error, payload} ->
        payload =
          if tool in Tools.supported_tool_names() do
            payload
          else
            unsupported_tool_payload(tool)
          end

        dynamic_tool_response(false, Tools.encode_payload(payload))
    end
  end

  @spec tool_specs() :: [map()]
  def tool_specs, do: Tools.tool_specs()

  defp missing_tool_payload do
    %{
      "error" => %{
        "message" => "Dynamic tool name is required.",
        "supportedTools" => Tools.supported_tool_names()
      }
    }
  end

  defp unsupported_tool_payload(tool) do
    %{
      "error" => %{
        "message" => "Unsupported dynamic tool: #{inspect(tool)}.",
        "supportedTools" => Tools.supported_tool_names()
      }
    }
  end

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
