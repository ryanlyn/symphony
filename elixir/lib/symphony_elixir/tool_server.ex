defmodule SymphonyElixir.ToolServer do
  @moduledoc """
  Unified linear_graphql handler for both Claude and Codex executors.
  """

  alias SymphonyElixir.Linear.Client

  @spec handle_linear_graphql(String.t(), map(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def handle_linear_graphql(query, variables, opts)
      when is_binary(query) and is_map(variables) and is_list(opts) do
    execute_passthrough(query, variables, opts)
  end

  defp execute_passthrough(query, variables, opts) do
    linear_client = Keyword.get(opts, :linear_client, &Client.graphql/3)
    linear_client.(query, variables, [])
  end
end
