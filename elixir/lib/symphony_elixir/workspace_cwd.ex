defmodule SymphonyElixir.WorkspaceCwd do
  @moduledoc false

  alias SymphonyElixir.{Config, PathSafety, SSH}

  @spec validate(Path.t(), String.t() | nil) :: {:ok, String.t()} | {:error, term()}
  def validate(workspace, nil) when is_binary(workspace) do
    expanded_workspace = Path.expand(workspace)
    expanded_root = Path.expand(Config.settings!().workspace.root)

    with {:ok, canonical_workspace} <- PathSafety.canonicalize(expanded_workspace),
         {:ok, canonical_root} <- PathSafety.canonicalize(expanded_root) do
      case validate_workspace_path_result(
             expanded_workspace,
             expanded_root,
             canonical_workspace,
             canonical_root
           ) do
        {:ok, validated_workspace} ->
          {:ok, validated_workspace}

        {:error, {:workspace_equals_root, path, _root}} ->
          {:error, {:invalid_workspace_cwd, :workspace_root, path}}

        {:error, {:workspace_symlink_escape, expanded_workspace, canonical_root}} ->
          {:error, {:invalid_workspace_cwd, :symlink_escape, expanded_workspace, canonical_root}}

        {:error, {:workspace_outside_root, canonical_workspace, canonical_root}} ->
          {:error, {:invalid_workspace_cwd, :outside_workspace_root, canonical_workspace, canonical_root}}
      end
    else
      {:error, {:path_canonicalize_failed, path, reason}} ->
        {:error, {:invalid_workspace_cwd, :path_unreadable, path, reason}}
    end
  end

  def validate(workspace, worker_host) when is_binary(workspace) and is_binary(worker_host) do
    case validate_remote_workspace_path(workspace, worker_host) do
      {:ok, validated_workspace} ->
        {:ok, validated_workspace}

      {:error, reason} ->
        {:error, remote_validation_error(reason, worker_host)}
    end
  end

  defp validate_remote_workspace_path(workspace, worker_host)
       when is_binary(workspace) and is_binary(worker_host) do
    cond do
      String.trim(workspace) == "" ->
        {:error, {:remote_workspace_input_empty, workspace}}

      String.contains?(workspace, ["\n", "\r", <<0>>]) ->
        {:error, {:remote_workspace_input_invalid, workspace}}

      true ->
        with {:ok, workspace_root} <- remote_workspace_root(worker_host, Config.settings!().workspace.root),
             {:ok, expanded_workspace} <-
               expand_remote_workspace_path(workspace, worker_host, workspace_root),
             expanded_root = Path.expand(workspace_root),
             {:ok, canonical_workspace} <- canonicalize_remote_path(expanded_workspace, worker_host),
             {:ok, canonical_root} <- canonicalize_remote_path(expanded_root, worker_host) do
          validate_workspace_path_result(
            expanded_workspace,
            expanded_root,
            canonical_workspace,
            canonical_root
          )
        end
    end
  end

  defp validate_workspace_path_result(
         expanded_workspace,
         expanded_root,
         canonical_workspace,
         canonical_root
       )
       when is_binary(expanded_workspace) and is_binary(expanded_root) and
              is_binary(canonical_workspace) and is_binary(canonical_root) do
    expanded_root_prefix = expanded_root <> "/"
    canonical_root_prefix = canonical_root <> "/"

    cond do
      canonical_workspace == canonical_root ->
        {:error, {:workspace_equals_root, canonical_workspace, canonical_root}}

      String.starts_with?(canonical_workspace <> "/", canonical_root_prefix) ->
        {:ok, canonical_workspace}

      String.starts_with?(expanded_workspace <> "/", expanded_root_prefix) ->
        {:error, {:workspace_symlink_escape, expanded_workspace, canonical_root}}

      true ->
        {:error, {:workspace_outside_root, canonical_workspace, canonical_root}}
    end
  end

  defp remote_validation_error({:workspace_equals_root, path, _root}, _worker_host) do
    {:invalid_workspace_cwd, :workspace_root, path}
  end

  defp remote_validation_error(
         {:workspace_symlink_escape, expanded_workspace, canonical_root},
         _worker_host
       ) do
    {:invalid_workspace_cwd, :symlink_escape, expanded_workspace, canonical_root}
  end

  defp remote_validation_error(
         {:workspace_outside_root, canonical_workspace, canonical_root},
         _worker_host
       ) do
    {:invalid_workspace_cwd, :outside_workspace_root, canonical_workspace, canonical_root}
  end

  defp remote_validation_error({:remote_workspace_input_empty, _workspace}, worker_host) do
    {:invalid_workspace_cwd, :empty_remote_workspace, worker_host}
  end

  defp remote_validation_error({:remote_workspace_input_invalid, invalid_workspace}, worker_host) do
    {:invalid_workspace_cwd, :invalid_remote_workspace, worker_host, invalid_workspace}
  end

  defp remote_validation_error({:workspace_path_unreadable, path, reason}, _worker_host) do
    {:invalid_workspace_cwd, :path_unreadable, path, reason}
  end

  defp remote_validation_error(reason, _worker_host), do: reason

  defp remote_workspace_root(worker_host, "~") when is_binary(worker_host) do
    remote_home(worker_host)
  end

  defp remote_workspace_root(worker_host, "~/" <> suffix) when is_binary(worker_host) do
    with {:ok, home} <- remote_home(worker_host) do
      {:ok, Path.join(home, suffix)}
    end
  end

  defp remote_workspace_root(_worker_host, workspace_root) when is_binary(workspace_root) do
    {:ok, workspace_root}
  end

  defp expand_remote_workspace_path("~", worker_host, _workspace_root) when is_binary(worker_host) do
    remote_workspace_root(worker_host, "~")
  end

  defp expand_remote_workspace_path("~/" <> suffix, worker_host, _workspace_root)
       when is_binary(worker_host) do
    remote_workspace_root(worker_host, "~/" <> suffix)
  end

  defp expand_remote_workspace_path(workspace, _worker_host, workspace_root)
       when is_binary(workspace) and is_binary(workspace_root) do
    {:ok, Path.expand(workspace, workspace_root)}
  end

  defp remote_home(worker_host) when is_binary(worker_host) do
    case SSH.run(worker_host, "printf '%s\\n' \"$HOME\"", stderr_to_stdout: true) do
      {:ok, {output, 0}} ->
        case String.trim(output) do
          "" -> {:error, {:remote_home_lookup_failed, worker_host, :empty_home}}
          home -> {:ok, home}
        end

      {:ok, {output, status}} ->
        {:error, {:remote_home_lookup_failed, worker_host, status, output}}

      {:error, reason} ->
        {:error, {:remote_home_lookup_failed, worker_host, reason}}
    end
  end

  defp canonicalize_remote_path(path, worker_host)
       when is_binary(path) and is_binary(worker_host) do
    script =
      [
        "set -eu",
        remote_shell_assign("path", path),
        "current=\"$path\"",
        "suffix=''",
        "while [ ! -e \"$current\" ] && [ \"$current\" != '/' ]; do",
        "  segment=${current##*/}",
        "  suffix=\"/$segment$suffix\"",
        "  current=${current%/*}",
        "  if [ -z \"$current\" ]; then current='/'; fi",
        "done",
        "if [ -d \"$current\" ]; then",
        "  resolved=$(cd \"$current\" && pwd -P)",
        "else",
        "  parent=${current%/*}",
        "  if [ -z \"$parent\" ]; then parent='/'; fi",
        "  segment=${current##*/}",
        "  resolved_parent=$(cd \"$parent\" && pwd -P)",
        "  if [ \"$resolved_parent\" = '/' ]; then",
        "    resolved=\"/$segment\"",
        "  else",
        "    resolved=\"$resolved_parent/$segment\"",
        "  fi",
        "fi",
        "if [ \"$resolved\" = '/' ]; then",
        "  printf '/%s\\n' \"${suffix#/}\"",
        "else",
        "  printf '%s\\n' \"$resolved$suffix\"",
        "fi"
      ]
      |> Enum.join("\n")

    case SSH.run(worker_host, script, stderr_to_stdout: true) do
      {:ok, {output, 0}} ->
        case String.trim(output) do
          "" -> {:error, {:workspace_path_unreadable, path, :empty}}
          canonical_path -> {:ok, canonical_path}
        end

      {:ok, {output, status}} ->
        {:error, {:workspace_path_unreadable, path, {:remote_canonicalize_failed, worker_host, status, output}}}

      {:error, reason} ->
        {:error, {:workspace_path_unreadable, path, {:remote_canonicalize_failed, worker_host, reason}}}
    end
  end

  defp remote_shell_assign(variable_name, raw_path)
       when is_binary(variable_name) and is_binary(raw_path) do
    [
      "#{variable_name}=#{SSH.shell_escape(raw_path)}",
      "case \"$#{variable_name}\" in",
      "  '~') #{variable_name}=\"$HOME\" ;;",
      "  '~/'*) " <> variable_name <> "=\"$HOME/${" <> variable_name <> "#~/}\" ;;",
      "esac"
    ]
    |> Enum.join("\n")
  end
end
