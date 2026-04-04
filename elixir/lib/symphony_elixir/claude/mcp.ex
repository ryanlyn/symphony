defmodule SymphonyElixir.Claude.Mcp do
  @moduledoc false

  alias SymphonyElixir.{Config, HttpServer, SSH}

  @dir_relative_path ".symphony/claude"
  @config_filename "mcp.json"
  @server_filename "linear_graphql_mcp.py"

  @spec prepare(Path.t(), String.t() | nil, keyword()) ::
          {:ok, %{config_path: String.t(), sidecar_path: String.t()}} | {:error, term()}
  def prepare(workspace, worker_host \\ nil, opts \\ []) when is_binary(workspace) do
    config_path = Path.join([workspace, @dir_relative_path, @config_filename])
    sidecar_path = Path.join([workspace, @dir_relative_path, @server_filename])
    python = Config.settings!().claude.mcp_server_python

    slot_env = slot_env_vars(opts)

    with :ok <- write_workspace_file(sidecar_path, sidecar_contents(), worker_host, executable?: true),
         :ok <- write_workspace_file(config_path, config_contents(sidecar_path, python, slot_env), worker_host, []) do
      {:ok, %{config_path: config_path, sidecar_path: sidecar_path}}
    end
  end

  @spec tool_names() :: [String.t()]
  def tool_names, do: ["mcp__symphony_linear__linear_graphql"]

  @spec allowed_tools() :: [String.t()]
  def allowed_tools do
    [
      "Bash",
      "Edit",
      "Write"
      | tool_names()
    ]
  end

  @spec config_contents(String.t(), String.t(), map()) :: String.t()
  def config_contents(sidecar_path, python, slot_env \\ %{})
      when is_binary(sidecar_path) and is_binary(python) and is_map(slot_env) do
    tracker = Config.settings!().tracker

    base_env = %{
      "SYMPHONY_LINEAR_API_KEY" => tracker.api_key,
      "SYMPHONY_LINEAR_ENDPOINT" => tracker.endpoint
    }

    env = Map.merge(base_env, slot_env)

    %{
      "mcpServers" => %{
        "symphony_linear" => %{
          "type" => "stdio",
          "command" => python,
          "args" => [sidecar_path],
          "env" => env
        }
      }
    }
    |> Jason.encode!(pretty: true)
  end

  @spec sidecar_contents() :: String.t()
  def sidecar_contents do
    """
    #!/usr/bin/env python3
    import json
    import os
    import sys
    import urllib.error
    import urllib.request

    TOOL_NAME = "linear_graphql"

    def read_message():
        while True:
            line = sys.stdin.readline()
            if not line:
                return None
            stripped = line.strip()
            if not stripped:
                continue

            if stripped.lower().startswith("content-length:"):
                length = int(stripped.split(":", 1)[1].strip())

                while True:
                    separator = sys.stdin.readline()
                    if not separator:
                        return None
                    if separator.strip() == "":
                        break

                payload = sys.stdin.read(length)
                return json.loads(payload)

            return json.loads(stripped)

    def write_message(message):
        sys.stdout.write(json.dumps(message))
        sys.stdout.write("\\n")
        sys.stdout.flush()

    def tool_schema():
        return {
            "name": TOOL_NAME,
            "description": "Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["query"],
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "GraphQL query or mutation document to execute against Linear."
                    },
                    "variables": {
                        "type": ["object", "null"],
                        "description": "Optional GraphQL variables object.",
                        "additionalProperties": True
                    }
                }
            }
        }

    def tool_error(message, extra=None):
        payload = {"error": {"message": message}}
        if isinstance(extra, dict):
            payload["error"].update(extra)
        return payload

    def has_state_id(variables):
        if "stateId" in variables:
            return True
        for v in variables.values():
            if isinstance(v, dict) and "stateId" in v:
                return True
        return False

    def barrier_request(query, variables):
        port = os.environ.get("SYMPHONY_HTTP_PORT")
        issue_id = os.environ.get("SYMPHONY_ISSUE_ID")
        slot_index = int(os.environ.get("SYMPHONY_SLOT_INDEX", "0"))

        body = json.dumps({
            "issue_id": issue_id,
            "slot_index": slot_index,
            "query": query,
            "variables": variables
        }).encode("utf-8")

        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/barrier/check",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST"
        )

        try:
            with urllib.request.urlopen(request) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return tool_error(f"Barrier request failed with HTTP {error.code}.", {"status": error.code}), True
        except urllib.error.URLError as error:
            return tool_error("Barrier request failed.", {"reason": repr(error.reason)}), True
        except Exception as error:
            return tool_error("Barrier request failed.", {"reason": repr(error)}), True

        is_error = isinstance(payload.get("errors"), list) and len(payload["errors"]) > 0
        return payload, is_error

    def graphql_request(arguments):
        if not isinstance(arguments, dict):
            return tool_error("`linear_graphql` expects an object with `query` and optional `variables`."), True

        query = arguments.get("query")
        variables = arguments.get("variables") or {}

        if not isinstance(query, str) or not query.strip():
            return tool_error("`linear_graphql` requires a non-empty `query` string."), True

        if not isinstance(variables, dict):
            return tool_error("`linear_graphql.variables` must be a JSON object when provided."), True

        ensemble_size = int(os.environ.get("SYMPHONY_ENSEMBLE_SIZE", "1"))

        if ensemble_size > 1 and "issueUpdate" in query and has_state_id(variables):
            return barrier_request(query, variables)

        api_key = os.environ.get("SYMPHONY_LINEAR_API_KEY")
        endpoint = os.environ.get("SYMPHONY_LINEAR_ENDPOINT", "https://api.linear.app/graphql")

        if not api_key:
            return tool_error("Symphony is missing Linear auth. Set `tracker.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`."), True

        body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": api_key
            },
            method="POST"
        )

        try:
            with urllib.request.urlopen(request) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return tool_error(f"Linear GraphQL request failed with HTTP {error.code}.", {"status": error.code}), True
        except urllib.error.URLError as error:
            return tool_error("Linear GraphQL request failed before receiving a successful response.", {"reason": repr(error.reason)}), True
        except Exception as error:
            return tool_error("Linear GraphQL tool execution failed.", {"reason": repr(error)}), True

        is_error = isinstance(payload, dict) and isinstance(payload.get("errors"), list) and len(payload["errors"]) > 0
        return payload, is_error

    def handle_request(message):
        method = message.get("method")
        request_id = message.get("id")

        if method == "initialize":
            params = message.get("params") or {}

            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": params.get("protocolVersion") or "2025-11-25",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "symphony-linear-graphql", "version": "0.1.0"}
                }
            }

        if method == "notifications/initialized":
            return None

        if method == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"tools": [tool_schema()]}
            }

        if method == "tools/call":
            params = message.get("params") or {}
            name = params.get("name")
            arguments = params.get("arguments") or {}

            if name != TOOL_NAME:
                payload = tool_error(f"Unsupported tool: {name!r}.", {"supportedTools": [TOOL_NAME]})
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "content": [{"type": "text", "text": json.dumps(payload, indent=2)}],
                        "isError": True
                    }
                }

            payload, is_error = graphql_request(arguments)
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(payload, indent=2)}],
                    "isError": is_error
                }
            }

        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"}
        }

    while True:
        message = read_message()
        if message is None:
            break

        response = handle_request(message)
        if response is not None:
            write_message(response)
    """
  end

  @spec slot_env_vars(keyword()) :: map()
  defp slot_env_vars(opts) do
    issue_id = Keyword.get(opts, :issue_id)
    slot_index = Keyword.get(opts, :slot_index)
    ensemble_size = Keyword.get(opts, :ensemble_size)
    http_port = HttpServer.bound_port()

    env = %{}

    env = if issue_id, do: Map.put(env, "SYMPHONY_ISSUE_ID", to_string(issue_id)), else: env
    env = if slot_index, do: Map.put(env, "SYMPHONY_SLOT_INDEX", to_string(slot_index)), else: env
    env = if ensemble_size, do: Map.put(env, "SYMPHONY_ENSEMBLE_SIZE", to_string(ensemble_size)), else: env
    env = if http_port, do: Map.put(env, "SYMPHONY_HTTP_PORT", to_string(http_port)), else: env

    env
  end

  @spec write_workspace_file(String.t(), iodata(), String.t() | nil, keyword()) :: :ok | {:error, term()}
  defp write_workspace_file(path, contents, nil, opts) when is_binary(path) do
    with :ok <- File.mkdir_p(Path.dirname(path)),
         :ok <- File.write(path, contents),
         :ok <- maybe_chmod(path, opts) do
      :ok
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp write_workspace_file(path, contents, worker_host, opts)
       when is_binary(path) and is_binary(worker_host) do
    mode = if Keyword.get(opts, :executable?, false), do: 0o755, else: nil

    case SSH.write_file(worker_host, path, contents, mode: mode) do
      :ok ->
        :ok

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec maybe_chmod(String.t(), keyword()) :: :ok | {:error, term()}
  defp maybe_chmod(path, opts) when is_binary(path) do
    if Keyword.get(opts, :executable?, false) do
      File.chmod(path, 0o755)
    else
      :ok
    end
  end
end
