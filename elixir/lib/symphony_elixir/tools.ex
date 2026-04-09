defmodule SymphonyElixir.Tools do
  @moduledoc """
  Canonical tool registry and execution layer shared across executors.
  """

  alias SymphonyElixir.Linear.Client

  @linear_graphql_tool "linear_graphql"
  @linear_graphql_description """
  Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.
  """
  @linear_graphql_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
    "required" => ["query"],
    "properties" => %{
      "query" => %{
        "type" => "string",
        "description" => "GraphQL query or mutation document to execute against Linear."
      },
      "variables" => %{
        "type" => ["object", "null"],
        "description" => "Optional GraphQL variables object.",
        "additionalProperties" => true
      }
    }
  }

  @type execution_result ::
          {:ok, %{success: boolean(), payload: term()}} | {:error, map()}

  @spec tool_specs() :: [map()]
  def tool_specs do
    [
      %{
        "name" => @linear_graphql_tool,
        "description" => @linear_graphql_description,
        "inputSchema" => @linear_graphql_input_schema
      }
    ]
  end

  @spec supported_tool_names() :: [String.t()]
  def supported_tool_names do
    Enum.map(tool_specs(), & &1["name"])
  end

  @spec execute(String.t() | nil, term(), keyword()) :: execution_result()
  def execute(tool, arguments, opts \\ []) do
    do_execute(tool, arguments, opts)
  end

  defp do_execute(@linear_graphql_tool, arguments, opts) do
    case normalize_linear_graphql_arguments(arguments) do
      {:ok, query, variables} ->
        linear_client = Keyword.get(opts, :linear_client, &Client.graphql/3)

        case linear_client.(query, variables, []) do
          {:ok, response} ->
            {:ok, %{success: graphql_success?(response), payload: response}}

          {:error, reason} ->
            {:error, tool_error_payload(reason)}
        end

      {:error, reason} ->
        {:error, tool_error_payload(reason)}
    end
  end

  defp do_execute(_tool, _arguments, _opts), do: {:error, unsupported_tool_payload()}

  @spec unsupported_tool_payload() :: map()
  def unsupported_tool_payload do
    %{
      "error" => %{
        "message" => "Unsupported tool.",
        "supportedTools" => supported_tool_names()
      }
    }
  end

  @spec encode_payload(term()) :: String.t()
  def encode_payload(payload) when is_map(payload) or is_list(payload) do
    Jason.encode!(payload, pretty: true)
  end

  def encode_payload(payload), do: inspect(payload)

  defp normalize_linear_graphql_arguments(arguments) when is_binary(arguments) do
    case String.trim(arguments) do
      "" -> {:error, :missing_query}
      query -> {:ok, query, %{}}
    end
  end

  defp normalize_linear_graphql_arguments(arguments) when is_map(arguments) do
    case normalize_query(arguments) do
      {:ok, query} ->
        case normalize_variables(arguments) do
          {:ok, variables} -> {:ok, query, variables}
          {:error, reason} -> {:error, reason}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp normalize_linear_graphql_arguments(_arguments), do: {:error, :invalid_arguments}

  defp normalize_query(arguments) do
    case Map.get(arguments, "query") || Map.get(arguments, :query) do
      query when is_binary(query) ->
        case String.trim(query) do
          "" -> {:error, :missing_query}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, :missing_query}
    end
  end

  defp normalize_variables(arguments) do
    case Map.get(arguments, "variables") || Map.get(arguments, :variables) || %{} do
      variables when is_map(variables) -> {:ok, variables}
      _ -> {:error, :invalid_variables}
    end
  end

  defp graphql_success?(response) do
    case response do
      %{"errors" => errors} when is_list(errors) and errors != [] -> false
      %{errors: errors} when is_list(errors) and errors != [] -> false
      _ -> true
    end
  end

  defp tool_error_payload(:missing_query) do
    %{
      "error" => %{
        "message" => "`linear_graphql` requires a non-empty `query` string."
      }
    }
  end

  defp tool_error_payload(:invalid_arguments) do
    %{
      "error" => %{
        "message" => "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`."
      }
    }
  end

  defp tool_error_payload(:invalid_variables) do
    %{
      "error" => %{
        "message" => "`linear_graphql.variables` must be a JSON object when provided."
      }
    }
  end

  defp tool_error_payload(:missing_linear_api_token) do
    %{
      "error" => %{
        "message" => "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`."
      }
    }
  end

  defp tool_error_payload({:linear_api_status, status}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed with HTTP #{status}.",
        "status" => status
      }
    }
  end

  defp tool_error_payload({:linear_api_request, reason}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed before receiving a successful response.",
        "reason" => inspect(reason)
      }
    }
  end

  defp tool_error_payload(reason) do
    %{
      "error" => %{
        "message" => "Linear GraphQL tool execution failed.",
        "reason" => inspect(reason)
      }
    }
  end
end
