defmodule SymphonyElixir.PathSafetyTest do
  use ExUnit.Case

  alias SymphonyElixir.PathSafety

  defmodule FakeFile do
    def reset!, do: Process.put({__MODULE__, :responses}, %{})

    def put_response!(operation, path, responses) when is_list(responses) do
      Process.put(
        {__MODULE__, :responses},
        Map.put(Process.get({__MODULE__, :responses}, %{}), {operation, path}, responses)
      )
    end

    def mkdir(path), do: next_response(:mkdir, path, &File.mkdir/1)
    def lstat(path), do: next_response(:lstat, path, &File.lstat/1)
    def rm_rf(path), do: next_response(:rm_rf, path, &File.rm_rf/1)

    defp next_response(operation, path, fallback) do
      key = {operation, path}
      responses = Process.get({__MODULE__, :responses}, %{})

      case Map.get(responses, key) do
        [response | rest] ->
          Process.put({__MODULE__, :responses}, Map.put(responses, key, rest))
          response

        _ ->
          fallback.(path)
      end
    end
  end

  setup do
    previous_file_module = Application.get_env(:symphony_elixir, :path_safety_file_module)
    FakeFile.reset!()

    on_exit(fn ->
      FakeFile.reset!()

      case previous_file_module do
        nil -> Application.delete_env(:symphony_elixir, :path_safety_file_module)
        module -> Application.put_env(:symphony_elixir, :path_safety_file_module, module)
      end
    end)

    :ok
  end

  test "ensure_directory rejects a symlink swapped into a missing ancestor" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-path-safety-missing-ancestor-#{System.unique_integer([:positive])}"
      )

    workspace_root = Path.join(test_root, "workspaces")
    outside_root = Path.join(test_root, "outside")
    workspace = Path.join(workspace_root, "MT-RACE")

    on_exit(fn ->
      File.rm_rf(test_root)
    end)

    File.mkdir_p!(test_root)
    File.mkdir_p!(outside_root)

    assert {:ok, canonical_workspace} = PathSafety.canonicalize(workspace)
    assert String.ends_with?(canonical_workspace, "/workspaces/MT-RACE")
    canonical_workspace_root = Path.dirname(canonical_workspace)

    File.ln_s!(outside_root, canonical_workspace_root)

    assert {:error, {:path_create_failed, ^canonical_workspace, {:unsafe_symlink, ^canonical_workspace_root}}} =
             PathSafety.ensure_directory(canonical_workspace)

    refute File.exists?(Path.join(outside_root, "MT-RACE"))
  end

  test "ensure_directory rejects a symlink swapped into the final segment" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-path-safety-final-segment-#{System.unique_integer([:positive])}"
      )

    workspace_root = Path.join(test_root, "workspaces")
    outside_root = Path.join(test_root, "outside")
    workspace = Path.join(workspace_root, "MT-RACE")

    on_exit(fn ->
      File.rm_rf(test_root)
    end)

    File.mkdir_p!(workspace_root)
    File.mkdir_p!(outside_root)

    assert {:ok, canonical_workspace} = PathSafety.canonicalize(workspace)
    assert String.ends_with?(canonical_workspace, "/workspaces/MT-RACE")

    File.ln_s!(outside_root, canonical_workspace)

    assert {:error, {:path_create_failed, ^canonical_workspace, {:unsafe_symlink, ^canonical_workspace}}} =
             PathSafety.ensure_directory(canonical_workspace)
  end

  test "ensure_directory creates missing directories" do
    path =
      Path.join(
        canonical_temp_base("symphony-path-safety-create"),
        "MT-CREATE"
      )

    File.rm_rf!(path)
    on_exit(fn -> File.rm_rf(path) end)

    assert {:ok, ^path, true} = PathSafety.ensure_directory(path)
    assert File.dir?(path)
  end

  test "ensure_directory reuses an existing directory" do
    path =
      Path.join(
        canonical_temp_base("symphony-path-safety-existing"),
        "MT-EXISTING"
      )

    File.mkdir_p!(path)
    on_exit(fn -> File.rm_rf(path) end)

    assert {:ok, ^path, false} = PathSafety.ensure_directory(path)
  end

  test "ensure_directory replaces a stale final non-directory path" do
    path =
      Path.join(
        canonical_temp_base("symphony-path-safety-stale"),
        "MT-STALE"
      )

    File.rm_rf!(Path.dirname(path))
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, "stale")

    on_exit(fn -> File.rm_rf(Path.dirname(path)) end)

    assert {:ok, ^path, true} = PathSafety.ensure_directory(path)
    assert File.dir?(path)
  end

  test "ensure_directory returns file-system errors from mkdir" do
    path =
      Path.join(
        canonical_temp_base("symphony-path-safety-mkdir-error"),
        "MT-ERROR"
      )

    Application.put_env(:symphony_elixir, :path_safety_file_module, FakeFile)
    FakeFile.put_response!(:mkdir, path, [{:error, :enametoolong}])

    assert {:error, {:path_create_failed, ^path, :enametoolong}} =
             PathSafety.ensure_directory(path)
  end

  test "ensure_directory returns file-system errors from final-segment lstat" do
    path =
      Path.join(
        canonical_temp_base("symphony-path-safety-final-lstat-error"),
        "MT-LSTAT"
      )

    Application.put_env(:symphony_elixir, :path_safety_file_module, FakeFile)
    FakeFile.put_response!(:mkdir, path, [{:error, :eexist}])
    FakeFile.put_response!(:lstat, path, [{:error, :eacces}])

    assert {:error, {:path_create_failed, ^path, :eacces}} =
             PathSafety.ensure_directory(path)
  end

  test "ensure_directory retries when the final segment disappears between mkdir and lstat" do
    path =
      Path.join(
        canonical_temp_base("symphony-path-safety-final-retry"),
        "MT-RETRY"
      )

    Application.put_env(:symphony_elixir, :path_safety_file_module, FakeFile)
    FakeFile.put_response!(:mkdir, path, [{:error, :eexist}, :ok])
    FakeFile.put_response!(:lstat, path, [{:error, :enoent}])

    assert {:ok, ^path, true} = PathSafety.ensure_directory(path)
  end

  test "ensure_directory returns removal errors for stale final paths" do
    path =
      Path.join(
        canonical_temp_base("symphony-path-safety-remove-error"),
        "MT-REMOVE"
      )

    Application.put_env(:symphony_elixir, :path_safety_file_module, FakeFile)
    FakeFile.put_response!(:mkdir, path, [{:error, :eexist}])
    FakeFile.put_response!(:lstat, path, [{:ok, %File.Stat{type: :regular}}])
    FakeFile.put_response!(:rm_rf, path, [{:error, :eperm, path}])

    assert {:error, {:path_create_failed, ^path, {:path_remove_failed, ^path, :eperm}}} =
             PathSafety.ensure_directory(path)
  end

  test "ensure_directory rejects non-directory ancestor paths" do
    base = canonical_temp_base("symphony-path-safety-parent-file")
    path = Path.join([base, "MT-PARENT", "child"])
    parent = Path.join(base, "MT-PARENT")

    Application.put_env(:symphony_elixir, :path_safety_file_module, FakeFile)
    FakeFile.put_response!(:mkdir, parent, [{:error, :eexist}])
    FakeFile.put_response!(:lstat, parent, [{:ok, %File.Stat{type: :regular}}])

    assert {:error, {:path_create_failed, ^path, {:not_a_directory, ^parent}}} =
             PathSafety.ensure_directory(path)
  end

  test "ensure_directory retries when an ancestor disappears between mkdir and lstat" do
    base = canonical_temp_base("symphony-path-safety-parent-retry")
    path = Path.join([base, "MT-PARENT", "child"])
    parent = Path.join(base, "MT-PARENT")
    child = path

    Application.put_env(:symphony_elixir, :path_safety_file_module, FakeFile)
    FakeFile.put_response!(:mkdir, parent, [{:error, :eexist}, :ok])
    FakeFile.put_response!(:lstat, parent, [{:error, :enoent}])
    FakeFile.put_response!(:mkdir, child, [:ok])

    assert {:ok, ^path, true} = PathSafety.ensure_directory(path)
  end

  test "ensure_directory returns file-system errors from ancestor lstat" do
    base = canonical_temp_base("symphony-path-safety-parent-lstat-error")
    path = Path.join([base, "MT-PARENT", "child"])
    parent = Path.join(base, "MT-PARENT")

    Application.put_env(:symphony_elixir, :path_safety_file_module, FakeFile)
    FakeFile.put_response!(:mkdir, parent, [{:error, :eexist}])
    FakeFile.put_response!(:lstat, parent, [{:error, :eacces}])

    assert {:error, {:path_create_failed, ^path, :eacces}} =
             PathSafety.ensure_directory(path)
  end

  defp canonical_temp_base(name) do
    base = Path.join(System.tmp_dir!(), name)
    {:ok, canonical_base} = PathSafety.canonicalize(base)
    canonical_base
  end
end
