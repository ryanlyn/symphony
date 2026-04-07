defmodule SymphonyElixir.Claude.Mcp do
  @moduledoc false

  alias SymphonyElixir.Claude.McpServer
  alias SymphonyElixir.{SSH, Tools}

  @dir_relative_path ".symphony/claude"
  @config_filename "mcp.json"
  @path "/claude-mcp"

  @spec path() :: String.t()
  def path, do: @path

  @spec prepare(Path.t(), String.t(), String.t(), String.t() | nil) ::
          {:ok, %{config_path: String.t()}} | {:error, term()}
  def prepare(workspace, server_url, bearer_token, worker_host \\ nil)
      when is_binary(workspace) and is_binary(server_url) and is_binary(bearer_token) do
    config_path = Path.join([workspace, @dir_relative_path, @config_filename])

    with :ok <-
           write_workspace_file(
             config_path,
             config_contents(server_url, bearer_token),
             worker_host
           ) do
      {:ok, %{config_path: config_path}}
    end
  end

  @spec tool_names() :: [String.t()]
  def tool_names do
    Enum.map(Tools.supported_tool_names(), &"mcp__#{McpServer.server_name()}__#{&1}")
  end

  @spec allowed_tools() :: [String.t()]
  def allowed_tools do
    [
      "Bash",
      "Edit",
      "Write"
      | tool_names()
    ]
  end

  @spec config_contents(String.t(), String.t()) :: String.t()
  def config_contents(server_url, bearer_token)
      when is_binary(server_url) and is_binary(bearer_token) do
    %{
      "mcpServers" => %{
        McpServer.server_name() => %{
          "type" => "http",
          "url" => server_url,
          "headers" => %{
            "Authorization" => "Bearer #{bearer_token}"
          }
        }
      }
    }
    |> Jason.encode!(pretty: true)
  end

  @spec write_workspace_file(String.t(), iodata(), String.t() | nil) :: :ok | {:error, term()}
  defp write_workspace_file(path, contents, nil) when is_binary(path) do
    with :ok <- File.mkdir_p(Path.dirname(path)),
         :ok <- File.write(path, contents) do
      :ok
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp write_workspace_file(path, contents, worker_host)
       when is_binary(path) and is_binary(worker_host) do
    case SSH.write_file(worker_host, path, contents) do
      :ok -> :ok
      {:error, reason} -> {:error, reason}
    end
  end
end
