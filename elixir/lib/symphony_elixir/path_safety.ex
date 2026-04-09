defmodule SymphonyElixir.PathSafety do
  @moduledoc false

  @spec canonicalize(Path.t()) :: {:ok, Path.t()} | {:error, term()}
  def canonicalize(path) when is_binary(path) do
    expanded_path = Path.expand(path)
    {root, segments} = split_absolute_path(expanded_path)

    case resolve_segments(root, [], segments) do
      {:ok, canonical_path} ->
        {:ok, canonical_path}

      {:error, reason} ->
        {:error, {:path_canonicalize_failed, expanded_path, reason}}
    end
  end

  @spec ensure_directory(Path.t()) :: {:ok, Path.t(), boolean()} | {:error, term()}
  def ensure_directory(path) when is_binary(path) do
    expanded_path = Path.expand(path)
    {root, segments} = split_absolute_path(expanded_path)

    case ensure_directory_segments(root, [], segments, false) do
      {:ok, created?} ->
        {:ok, expanded_path, created?}

      {:error, reason} ->
        {:error, {:path_create_failed, expanded_path, reason}}
    end
  end

  defp split_absolute_path(path) when is_binary(path) do
    [root | segments] = Path.split(path)
    {root, segments}
  end

  defp resolve_segments(root, resolved_segments, []), do: {:ok, join_path(root, resolved_segments)}

  defp resolve_segments(root, resolved_segments, [segment | rest]) do
    candidate_path = join_path(root, resolved_segments ++ [segment])

    case file_module().lstat(candidate_path) do
      {:ok, %File.Stat{type: :symlink}} ->
        with {:ok, target} <- :file.read_link_all(String.to_charlist(candidate_path)) do
          resolved_target = Path.expand(IO.chardata_to_string(target), join_path(root, resolved_segments))
          {target_root, target_segments} = split_absolute_path(resolved_target)
          resolve_segments(target_root, [], target_segments ++ rest)
        end

      {:ok, _stat} ->
        resolve_segments(root, resolved_segments ++ [segment], rest)

      {:error, :enoent} ->
        {:ok, join_path(root, resolved_segments ++ [segment | rest])}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp ensure_directory_segments(_root, _resolved_segments, [], created?), do: {:ok, created?}

  defp ensure_directory_segments(root, resolved_segments, [segment | rest], created?) do
    candidate_path = join_path(root, resolved_segments ++ [segment])

    case file_module().mkdir(candidate_path) do
      :ok ->
        ensure_directory_segments(root, resolved_segments ++ [segment], rest, true)

      {:error, :eexist} ->
        handle_existing_path(root, resolved_segments, [segment | rest], candidate_path, created?)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp handle_existing_path(root, resolved_segments, [segment], candidate_path, created?) do
    case file_module().lstat(candidate_path) do
      {:ok, %File.Stat{type: :directory}} ->
        {:ok, created?}

      {:ok, %File.Stat{type: :symlink}} ->
        {:error, {:unsafe_symlink, candidate_path}}

      {:ok, _stat} ->
        case file_module().rm_rf(candidate_path) do
          {:ok, _removed_paths} ->
            ensure_directory_segments(root, resolved_segments, [segment], true)

          {:error, reason, failed_path} ->
            {:error, {:path_remove_failed, failed_path, reason}}
        end

      {:error, :enoent} ->
        ensure_directory_segments(root, resolved_segments, [segment], created?)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp handle_existing_path(root, resolved_segments, [segment | rest], candidate_path, created?) do
    case file_module().lstat(candidate_path) do
      {:ok, %File.Stat{type: :directory}} ->
        ensure_directory_segments(root, resolved_segments ++ [segment], rest, created?)

      {:ok, %File.Stat{type: :symlink}} ->
        {:error, {:unsafe_symlink, candidate_path}}

      {:ok, _stat} ->
        {:error, {:not_a_directory, candidate_path}}

      {:error, :enoent} ->
        ensure_directory_segments(root, resolved_segments, [segment | rest], created?)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp join_path(root, segments) when is_list(segments) do
    Enum.reduce(segments, root, fn segment, acc -> Path.join(acc, segment) end)
  end

  defp file_module do
    Application.get_env(:symphony_elixir, :path_safety_file_module, File)
  end
end
