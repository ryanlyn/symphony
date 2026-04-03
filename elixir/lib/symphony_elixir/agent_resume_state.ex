defmodule SymphonyElixir.AgentResumeState do
  @moduledoc false

  alias SymphonyElixir.SSH

  @resume_state_relative_path "symphony/resume.json"
  @remote_missing_marker "__SYMPHONY_RESUME_STATE_MISSING__"

  @type state :: %{
          agent_kind: String.t(),
          resume_id: String.t(),
          session_id: String.t() | nil,
          issue_id: String.t() | nil,
          issue_identifier: String.t() | nil,
          issue_state: String.t() | nil,
          workspace_path: String.t() | nil,
          worker_host: String.t() | nil,
          updated_at: String.t() | nil,
          thread_id: String.t() | nil
        }

  @spec read(Path.t()) :: {:ok, state()} | :missing | {:error, term()}
  def read(workspace) when is_binary(workspace), do: read(workspace, nil)

  @spec read(Path.t(), String.t() | nil) :: {:ok, state()} | :missing | {:error, term()}
  def read(workspace, worker_host) when is_binary(workspace) do
    with {:ok, path} <- resume_state_path(workspace, worker_host),
         {:ok, contents} <- read_resume_state_file(path, worker_host) do
      decode_state(contents)
    else
      :missing ->
        :missing

      {:error, {:git_dir_lookup_failed, _status, _output}} ->
        :missing

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec write(Path.t(), map()) :: :ok | {:error, term()}
  def write(workspace, attrs) when is_binary(workspace) and is_map(attrs) do
    write(workspace, attrs, nil)
  end

  @spec write(Path.t(), map(), String.t() | nil) :: :ok | {:error, term()}
  def write(workspace, attrs, worker_host) when is_binary(workspace) and is_map(attrs) do
    with {:ok, path} <- resume_state_path(workspace, worker_host),
         {:ok, payload} <- encode_state(attrs),
         :ok <- write_resume_state_file(path, payload, worker_host) do
      :ok
    else
      {:error, {:git_dir_lookup_failed, _status, _output}} ->
        :ok

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec delete(Path.t()) :: :ok | {:error, term()}
  def delete(workspace) when is_binary(workspace), do: delete(workspace, nil)

  @spec delete(Path.t(), String.t() | nil) :: :ok | {:error, term()}
  def delete(workspace, worker_host) when is_binary(workspace) do
    with {:ok, path} <- resume_state_path(workspace, worker_host),
         :ok <- delete_resume_state_file(path, worker_host) do
      :ok
    else
      {:error, {:git_dir_lookup_failed, _status, _output}} ->
        :ok

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec resume_state_path(Path.t(), String.t() | nil) :: {:ok, Path.t()} | {:error, term()}
  defp resume_state_path(workspace, worker_host) when is_binary(workspace) do
    with {:ok, git_dir} <- resolve_git_dir(workspace, worker_host) do
      {:ok, Path.join(git_dir, @resume_state_relative_path)}
    end
  end

  @spec resolve_git_dir(Path.t(), String.t() | nil) :: {:ok, Path.t()} | {:error, term()}
  defp resolve_git_dir(workspace, nil) when is_binary(workspace) do
    case System.cmd("git", ["rev-parse", "--git-dir"], cd: workspace, stderr_to_stdout: true) do
      {git_dir, 0} ->
        git_dir = String.trim(git_dir)
        {:ok, Path.expand(git_dir, workspace)}

      {output, status} ->
        {:error, {:git_dir_lookup_failed, status, output}}
    end
  end

  defp resolve_git_dir(workspace, worker_host)
       when is_binary(workspace) and is_binary(worker_host) do
    command = "git -C #{SSH.shell_escape(workspace)} rev-parse --git-dir"

    case SSH.run(worker_host, command, stderr_to_stdout: true) do
      {:ok, {git_dir, 0}} ->
        git_dir = git_dir |> String.trim()
        {:ok, Path.expand(git_dir, workspace)}

      {:ok, {output, status}} ->
        {:error, {:git_dir_lookup_failed, status, output}}

      {:error, reason} ->
        {:error, {:git_dir_lookup_failed, :ssh_failed, inspect(reason)}}
    end
  end

  @spec read_resume_state_file(Path.t(), String.t() | nil) :: {:ok, String.t()} | :missing | {:error, term()}
  defp read_resume_state_file(path, nil) when is_binary(path) do
    case File.read(path) do
      {:ok, contents} -> {:ok, contents}
      {:error, :enoent} -> :missing
      {:error, reason} -> {:error, {:resume_state_read_failed, reason}}
    end
  end

  defp read_resume_state_file(path, worker_host) when is_binary(path) and is_binary(worker_host) do
    command = """
    if [ -f #{SSH.shell_escape(path)} ]; then
      cat #{SSH.shell_escape(path)}
    else
      printf '%s' #{SSH.shell_escape(@remote_missing_marker)}
    fi
    """

    case SSH.run(worker_host, command, stderr_to_stdout: true) do
      {:ok, {@remote_missing_marker, 0}} ->
        :missing

      {:ok, {contents, 0}} ->
        {:ok, contents}

      {:ok, {_output, status}} ->
        {:error, {:resume_state_read_failed, {:remote_exit, status}}}

      {:error, reason} ->
        {:error, {:resume_state_read_failed, reason}}
    end
  end

  @spec write_resume_state_file(Path.t(), iodata(), String.t() | nil) :: :ok | {:error, term()}
  defp write_resume_state_file(path, payload, nil) when is_binary(path) do
    path
    |> Path.dirname()
    |> File.mkdir_p()
    |> case do
      :ok -> File.write(path, payload)
      {:error, reason} -> {:error, reason}
    end
    |> case do
      :ok -> :ok
      {:error, reason} -> {:error, {:resume_state_write_failed, reason}}
    end
  end

  defp write_resume_state_file(path, payload, worker_host)
       when is_binary(path) and is_binary(worker_host) do
    case SSH.write_file(worker_host, path, payload) do
      :ok ->
        :ok

      {:error, {:remote_write_failed, status, _output}} ->
        {:error, {:resume_state_write_failed, {:remote_exit, status}}}

      {:error, reason} ->
        {:error, {:resume_state_write_failed, reason}}
    end
  end

  @spec delete_resume_state_file(Path.t(), String.t() | nil) :: :ok | {:error, term()}
  defp delete_resume_state_file(path, nil) when is_binary(path) do
    case File.rm(path) do
      :ok -> :ok
      {:error, :enoent} -> :ok
      {:error, reason} -> {:error, {:resume_state_delete_failed, reason}}
    end
  end

  defp delete_resume_state_file(path, worker_host) when is_binary(path) and is_binary(worker_host) do
    command = "rm -f #{SSH.shell_escape(path)}"

    case SSH.run(worker_host, command, stderr_to_stdout: true) do
      {:ok, {_output, 0}} -> :ok
      {:ok, {_output, status}} -> {:error, {:resume_state_delete_failed, {:remote_exit, status}}}
      {:error, reason} -> {:error, {:resume_state_delete_failed, reason}}
    end
  end

  @spec encode_state(map()) :: {:ok, iodata()} | {:error, term()}
  defp encode_state(attrs) when is_map(attrs) do
    resume_id = Map.get(attrs, :resume_id) || Map.get(attrs, :thread_id)

    case resume_id do
      value when is_binary(value) and value != "" ->
        agent_kind =
          case Map.get(attrs, :agent_kind) do
            kind when is_binary(kind) and kind != "" -> kind
            _ -> "codex"
          end

        payload =
          %{
            "agent_kind" => agent_kind,
            "resume_id" => value,
            "session_id" => Map.get(attrs, :session_id),
            "issue_id" => Map.get(attrs, :issue_id),
            "issue_identifier" => Map.get(attrs, :issue_identifier),
            "issue_state" => Map.get(attrs, :issue_state),
            "workspace_path" => Map.get(attrs, :workspace_path),
            "worker_host" => Map.get(attrs, :worker_host),
            "updated_at" => Map.get(attrs, :updated_at)
          }
          |> maybe_put_thread_id(agent_kind, value)

        {:ok, Jason.encode_to_iodata!(payload)}

      _ ->
        {:error, :invalid_resume_state}
    end
  end

  @spec decode_state(String.t()) :: {:ok, state()} | {:error, term()}
  defp decode_state(contents) when is_binary(contents) do
    with {:ok, data} <- Jason.decode(contents),
         resume_id when is_binary(resume_id) and resume_id != "" <-
           Map.get(data, "resume_id") || Map.get(data, "thread_id") do
      agent_kind = decode_agent_kind(data)

      {:ok,
       %{
         agent_kind: agent_kind,
         resume_id: resume_id,
         session_id: string_or_nil(Map.get(data, "session_id")),
         issue_id: string_or_nil(Map.get(data, "issue_id")),
         issue_identifier: string_or_nil(Map.get(data, "issue_identifier")),
         issue_state: string_or_nil(Map.get(data, "issue_state")),
         workspace_path: string_or_nil(Map.get(data, "workspace_path")),
         worker_host: string_or_nil(Map.get(data, "worker_host")),
         updated_at: string_or_nil(Map.get(data, "updated_at")),
         thread_id: decode_thread_id(data, agent_kind, resume_id)
       }}
    else
      {:error, reason} -> {:error, {:resume_state_decode_failed, reason}}
      _ -> {:error, :invalid_resume_state}
    end
  end

  defp decode_agent_kind(data) do
    case Map.get(data, "agent_kind") do
      kind when is_binary(kind) and kind != "" -> kind
      _ -> "codex"
    end
  end

  defp decode_thread_id(data, agent_kind, resume_id) do
    case Map.get(data, "thread_id") do
      value when is_binary(value) and value != "" -> value
      _ when agent_kind == "codex" -> resume_id
      _ -> nil
    end
  end

  @spec maybe_put_thread_id(map(), String.t(), String.t()) :: map()
  defp maybe_put_thread_id(payload, "codex", resume_id) when is_map(payload) and is_binary(resume_id) do
    Map.put(payload, "thread_id", resume_id)
  end

  defp maybe_put_thread_id(payload, _agent_kind, _resume_id), do: payload

  @spec string_or_nil(term()) :: String.t() | nil
  defp string_or_nil(value) when is_binary(value), do: value
  defp string_or_nil(_value), do: nil
end
