defmodule SymphonyElixir.Codex.ResumeState do
  @moduledoc false

  @resume_state_relative_path "symphony/resume.json"

  @type state :: %{
          thread_id: String.t(),
          session_id: String.t() | nil,
          issue_id: String.t() | nil,
          issue_identifier: String.t() | nil,
          issue_state: String.t() | nil,
          workspace_path: String.t() | nil,
          worker_host: String.t() | nil,
          updated_at: String.t() | nil
        }

  @spec read(Path.t()) :: {:ok, state()} | :missing | {:error, term()}
  def read(workspace) when is_binary(workspace), do: read(workspace, nil)

  @spec read(Path.t(), String.t() | nil) :: {:ok, state()} | :missing | {:error, term()}
  def read(workspace, nil) when is_binary(workspace) do
    with {:ok, path} <- resume_state_path(workspace) do
      path
      |> File.read()
      |> case do
        {:ok, contents} -> decode_state(contents)
        {:error, :enoent} -> :missing
        {:error, reason} -> {:error, {:resume_state_read_failed, reason}}
      end
    end
    |> ignore_missing_git_dir(:missing)
  end

  def read(workspace, worker_host) when is_binary(workspace) and is_binary(worker_host), do: :missing

  @spec write(Path.t(), map()) :: :ok | {:error, term()}
  def write(workspace, attrs) when is_binary(workspace) and is_map(attrs) do
    write(workspace, attrs, nil)
  end

  @spec write(Path.t(), map(), String.t() | nil) :: :ok | {:error, term()}
  def write(workspace, attrs, nil) when is_binary(workspace) and is_map(attrs) do
    with {:ok, path} <- resume_state_path(workspace),
         {:ok, payload} <- encode_state(attrs) do
      write_resume_state_file(path, payload)
    end
    |> ignore_missing_git_dir(:ok)
  end

  def write(workspace, attrs, worker_host) when is_binary(workspace) and is_map(attrs) and is_binary(worker_host), do: :ok

  @spec delete(Path.t()) :: :ok | {:error, term()}
  def delete(workspace) when is_binary(workspace), do: delete(workspace, nil)

  @spec delete(Path.t(), String.t() | nil) :: :ok | {:error, term()}
  def delete(workspace, nil) when is_binary(workspace) do
    with {:ok, path} <- resume_state_path(workspace) do
      delete_resume_state_file(path)
    end
    |> ignore_missing_git_dir(:ok)
  end

  def delete(workspace, worker_host) when is_binary(workspace) and is_binary(worker_host), do: :ok

  @spec resume_state_path(Path.t()) :: {:ok, Path.t()} | {:error, term()}
  defp resume_state_path(workspace) when is_binary(workspace) do
    with {:ok, git_dir} <- resolve_git_dir(workspace) do
      {:ok, Path.join(git_dir, @resume_state_relative_path)}
    end
  end

  @spec resolve_git_dir(Path.t()) :: {:ok, Path.t()} | {:error, term()}
  defp resolve_git_dir(workspace) when is_binary(workspace) do
    case System.cmd("git", ["rev-parse", "--git-dir"], cd: workspace, stderr_to_stdout: true) do
      {git_dir, 0} ->
        git_dir = String.trim(git_dir)
        {:ok, Path.expand(git_dir, workspace)}

      {output, status} ->
        {:error, {:git_dir_lookup_failed, status, output}}
    end
  end

  @spec write_resume_state_file(Path.t(), iodata()) :: :ok | {:error, term()}
  defp write_resume_state_file(path, payload) when is_binary(path) do
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

  @spec delete_resume_state_file(Path.t()) :: :ok | {:error, term()}
  defp delete_resume_state_file(path) when is_binary(path) do
    case File.rm(path) do
      :ok -> :ok
      {:error, :enoent} -> :ok
      {:error, reason} -> {:error, {:resume_state_delete_failed, reason}}
    end
  end

  @spec encode_state(map()) :: {:ok, iodata()} | {:error, term()}
  defp encode_state(attrs) when is_map(attrs) do
    case Map.get(attrs, :thread_id) do
      thread_id when is_binary(thread_id) and thread_id != "" ->
        {:ok,
         Jason.encode_to_iodata!(%{
           "thread_id" => thread_id,
           "session_id" => Map.get(attrs, :session_id),
           "issue_id" => Map.get(attrs, :issue_id),
           "issue_identifier" => Map.get(attrs, :issue_identifier),
           "issue_state" => Map.get(attrs, :issue_state),
           "workspace_path" => Map.get(attrs, :workspace_path),
           "worker_host" => Map.get(attrs, :worker_host),
           "updated_at" => Map.get(attrs, :updated_at)
         })}

      _ ->
        {:error, :invalid_resume_state}
    end
  end

  @spec decode_state(String.t()) :: {:ok, state()} | {:error, term()}
  defp decode_state(contents) when is_binary(contents) do
    with {:ok, data} <- Jason.decode(contents),
         thread_id when is_binary(thread_id) and thread_id != "" <- Map.get(data, "thread_id") do
      {:ok,
       %{
         thread_id: thread_id,
         session_id: string_or_nil(Map.get(data, "session_id")),
         issue_id: string_or_nil(Map.get(data, "issue_id")),
         issue_identifier: string_or_nil(Map.get(data, "issue_identifier")),
         issue_state: string_or_nil(Map.get(data, "issue_state")),
         workspace_path: string_or_nil(Map.get(data, "workspace_path")),
         worker_host: string_or_nil(Map.get(data, "worker_host")),
         updated_at: string_or_nil(Map.get(data, "updated_at"))
       }}
    else
      {:error, reason} -> {:error, {:resume_state_decode_failed, reason}}
      _ -> {:error, :invalid_resume_state}
    end
  end

  @spec string_or_nil(term()) :: String.t() | nil
  defp string_or_nil(value) when is_binary(value), do: value
  defp string_or_nil(_value), do: nil

  @spec ignore_missing_git_dir(:ok | :missing | {:ok, state()} | {:error, term()}, :ok | :missing) ::
          :ok | :missing | {:ok, state()} | {:error, term()}
  defp ignore_missing_git_dir({:error, {:git_dir_lookup_failed, _status, _output}}, fallback), do: fallback
  defp ignore_missing_git_dir(result, _fallback), do: result
end
