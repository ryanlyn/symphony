defmodule SymphonyElixir.WorkspaceCwdTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.{PathSafety, SSH, WorkspaceCwd}

  test "remote validation rejects the workspace root and paths outside the configured root" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-remote-workspace-cwd-guard-#{System.unique_integer([:positive])}"
      )

    previous_path = System.get_env("PATH")
    previous_trace = System.get_env("SYMP_TEST_SSH_TRACE")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      restore_env("SYMP_TEST_SSH_TRACE", previous_trace)
    end)

    try do
      trace_file = Path.join(test_root, "ssh.trace")
      fake_ssh = Path.join(test_root, "ssh")
      workspace_root = Path.join(test_root, "remote-workspaces")
      outside_root = Path.join(test_root, "outside")

      File.mkdir_p!(workspace_root)
      File.mkdir_p!(outside_root)
      {:ok, canonical_workspace_root} = PathSafety.canonicalize(workspace_root)
      {:ok, canonical_outside_root} = PathSafety.canonicalize(outside_root)
      System.put_env("SYMP_TEST_SSH_TRACE", trace_file)
      System.put_env("PATH", test_root <> ":" <> (previous_path || ""))

      File.write!(fake_ssh, fake_ssh_script())
      File.chmod!(fake_ssh, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      assert {:error, {:invalid_workspace_cwd, :workspace_root, ^canonical_workspace_root}} =
               WorkspaceCwd.validate(workspace_root, "worker-01")

      assert {
               :error,
               {:invalid_workspace_cwd, :outside_workspace_root, ^canonical_outside_root, ^canonical_workspace_root}
             } =
               WorkspaceCwd.validate(outside_root, "worker-01")

      trace = File.read!(trace_file)
      assert trace =~ "worker-01 bash -lc"
      assert trace =~ "pwd -P"
    after
      File.rm_rf(test_root)
    end
  end

  test "remote validation rejects symlink escapes under the configured root" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-remote-workspace-cwd-symlink-#{System.unique_integer([:positive])}"
      )

    previous_path = System.get_env("PATH")
    previous_trace = System.get_env("SYMP_TEST_SSH_TRACE")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      restore_env("SYMP_TEST_SSH_TRACE", previous_trace)
    end)

    try do
      trace_file = Path.join(test_root, "ssh.trace")
      fake_ssh = Path.join(test_root, "ssh")
      workspace_root = Path.join(test_root, "remote-workspaces")
      outside_root = Path.join(test_root, "outside")
      symlink_workspace = Path.join(workspace_root, "MT-SYM")

      File.mkdir_p!(workspace_root)
      File.mkdir_p!(outside_root)
      File.ln_s!(outside_root, symlink_workspace)
      {:ok, canonical_workspace_root} = PathSafety.canonicalize(workspace_root)
      System.put_env("SYMP_TEST_SSH_TRACE", trace_file)
      System.put_env("PATH", test_root <> ":" <> (previous_path || ""))

      File.write!(fake_ssh, fake_ssh_script())
      File.chmod!(fake_ssh, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      assert {:error, {:invalid_workspace_cwd, :symlink_escape, ^symlink_workspace, ^canonical_workspace_root}} =
               WorkspaceCwd.validate(symlink_workspace, "worker-01")

      trace = File.read!(trace_file)
      assert trace =~ "worker-01 bash -lc"
      assert trace =~ symlink_workspace
    after
      File.rm_rf(test_root)
    end
  end

  test "remote validation accepts workspaces inside the configured root" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-remote-workspace-cwd-ok-#{System.unique_integer([:positive])}"
      )

    previous_path = System.get_env("PATH")
    previous_trace = System.get_env("SYMP_TEST_SSH_TRACE")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      restore_env("SYMP_TEST_SSH_TRACE", previous_trace)
    end)

    try do
      workspace_root = Path.join(test_root, "remote-workspaces")
      workspace = Path.join(workspace_root, "MT-OK")

      File.mkdir_p!(workspace)
      configure_fake_ssh!(test_root, previous_path, fake_ssh_script())
      {:ok, canonical_workspace} = PathSafety.canonicalize(workspace)

      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      assert {:ok, ^canonical_workspace} = WorkspaceCwd.validate(workspace, "worker-01")
    after
      File.rm_rf(test_root)
    end
  end

  test "remote validation expands tilde roots and workspaces" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-remote-workspace-cwd-tilde-#{System.unique_integer([:positive])}"
      )

    previous_path = System.get_env("PATH")
    previous_trace = System.get_env("SYMP_TEST_SSH_TRACE")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      restore_env("SYMP_TEST_SSH_TRACE", previous_trace)
    end)

    try do
      remote_home = Path.join(test_root, "remote-home")
      workspace_root = "~/.symphony-remote-workspaces"
      workspace = "~/.symphony-remote-workspaces/MT-TILDE"
      workspace_path = Path.join(remote_home, ".symphony-remote-workspaces/MT-TILDE")

      File.mkdir_p!(workspace_path)
      {:ok, expected_workspace} = PathSafety.canonicalize(workspace_path)

      configure_fake_ssh!(
        test_root,
        previous_path,
        fake_ssh_script({:output, remote_home})
      )

      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      assert {:ok, ^expected_workspace} = WorkspaceCwd.validate(workspace, "worker-01")
    after
      File.rm_rf(test_root)
    end
  end

  test "remote validation expands bare tilde roots and workspaces" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-remote-workspace-cwd-home-root-#{System.unique_integer([:positive])}"
      )

    previous_path = System.get_env("PATH")
    previous_trace = System.get_env("SYMP_TEST_SSH_TRACE")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      restore_env("SYMP_TEST_SSH_TRACE", previous_trace)
    end)

    try do
      remote_home = Path.join(test_root, "remote-home")
      {:ok, canonical_remote_home} = PathSafety.canonicalize(remote_home)

      File.mkdir_p!(remote_home)

      configure_fake_ssh!(
        test_root,
        previous_path,
        fake_ssh_script({:output, remote_home})
      )

      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "~")

      assert {:error, {:invalid_workspace_cwd, :workspace_root, ^canonical_remote_home}} =
               WorkspaceCwd.validate("~", "worker-01")
    after
      File.rm_rf(test_root)
    end
  end

  test "remote validation rejects empty and invalid workspace inputs" do
    assert {:error, {:invalid_workspace_cwd, :empty_remote_workspace, "worker-01"}} =
             WorkspaceCwd.validate("   ", "worker-01")

    assert {:error, {:invalid_workspace_cwd, :invalid_remote_workspace, "worker-01", "bad\npath"}} =
             WorkspaceCwd.validate("bad\npath", "worker-01")
  end

  test "local validation surfaces unreadable workspace paths" do
    workspace_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-workspace-cwd-unreadable-#{System.unique_integer([:positive])}"
      )

    invalid_segment = String.duplicate("a", 300)
    unreadable_workspace = Path.join(System.tmp_dir!(), invalid_segment)
    expanded_workspace = Path.expand(unreadable_workspace)

    try do
      File.mkdir_p!(workspace_root)
      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      assert {:error, {:invalid_workspace_cwd, :path_unreadable, ^expanded_workspace, :enametoolong}} =
               WorkspaceCwd.validate(unreadable_workspace, nil)
    after
      File.rm_rf(workspace_root)
    end
  end

  test "remote validation surfaces remote home lookup failures" do
    previous_path = System.get_env("PATH")
    previous_trace = System.get_env("SYMP_TEST_SSH_TRACE")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      restore_env("SYMP_TEST_SSH_TRACE", previous_trace)
    end)

    Enum.each(
      [
        {"empty", fake_ssh_script({:output, ""}), {:remote_home_lookup_failed, "worker-01", :empty_home}},
        {"status", fake_ssh_script({:status, 75, "lookup failed"}), {:remote_home_lookup_failed, "worker-01", 75, "lookup failed\n"}}
      ],
      fn {suffix, script, expected} ->
        test_root =
          Path.join(
            System.tmp_dir!(),
            "symphony-elixir-remote-workspace-cwd-home-failure-#{suffix}-#{System.unique_integer([:positive])}"
          )

        try do
          configure_fake_ssh!(test_root, previous_path, script)
          write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "~")

          assert {:error, ^expected} = WorkspaceCwd.validate("~", "worker-01")
        after
          File.rm_rf(test_root)
        end
      end
    )

    missing_ssh_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-remote-workspace-cwd-home-failure-missing-#{System.unique_integer([:positive])}"
      )

    try do
      File.mkdir_p!(missing_ssh_root)
      System.put_env("SYMP_TEST_SSH_TRACE", Path.join(missing_ssh_root, "ssh.trace"))
      System.put_env("PATH", missing_ssh_root)
      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "~")

      assert {:error, {:remote_home_lookup_failed, "worker-01", :ssh_not_found}} =
               WorkspaceCwd.validate("~", "worker-01")
    after
      File.rm_rf(missing_ssh_root)
    end
  end

  test "remote validation surfaces canonicalization failures" do
    previous_path = System.get_env("PATH")
    previous_trace = System.get_env("SYMP_TEST_SSH_TRACE")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      restore_env("SYMP_TEST_SSH_TRACE", previous_trace)
    end)

    Enum.each(
      [
        {"empty", fake_ssh_script(:exec, {:output, ""}), :empty},
        {"status", fake_ssh_script(:exec, {:status, 75, "cannot canonicalize"}), {:remote_canonicalize_failed, "worker-01", 75, "cannot canonicalize\n"}}
      ],
      fn {suffix, script, expected_reason} ->
        test_root =
          Path.join(
            System.tmp_dir!(),
            "symphony-elixir-remote-workspace-cwd-canonicalize-#{suffix}-#{System.unique_integer([:positive])}"
          )

        try do
          workspace_root = Path.join(test_root, "remote-workspaces")
          workspace = Path.join(workspace_root, "MT-CANON")

          File.mkdir_p!(workspace_root)
          configure_fake_ssh!(test_root, previous_path, script)
          write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

          assert {:error, {:invalid_workspace_cwd, :path_unreadable, ^workspace, ^expected_reason}} =
                   WorkspaceCwd.validate(workspace, "worker-01")
        after
          File.rm_rf(test_root)
        end
      end
    )

    missing_ssh_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-remote-workspace-cwd-canonicalize-missing-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(missing_ssh_root, "remote-workspaces")
      workspace = Path.join(workspace_root, "MT-CANON")

      File.mkdir_p!(workspace_root)
      System.put_env("SYMP_TEST_SSH_TRACE", Path.join(missing_ssh_root, "ssh.trace"))
      System.put_env("PATH", missing_ssh_root)
      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      assert {
               :error,
               {:invalid_workspace_cwd, :path_unreadable, ^workspace, {:remote_canonicalize_failed, "worker-01", :ssh_not_found}}
             } =
               WorkspaceCwd.validate(workspace, "worker-01")
    after
      File.rm_rf(missing_ssh_root)
    end
  end

  defp configure_fake_ssh!(test_root, previous_path, script) do
    trace_file = Path.join(test_root, "ssh.trace")
    fake_ssh = Path.join(test_root, "ssh")

    File.mkdir_p!(test_root)
    System.put_env("SYMP_TEST_SSH_TRACE", trace_file)
    System.put_env("PATH", test_root <> ":" <> (previous_path || ""))
    File.write!(fake_ssh, script)
    File.chmod!(fake_ssh, 0o755)

    trace_file
  end

  defp fake_ssh_script(home_behavior \\ :exec, command_behavior \\ :exec) do
    """
    #!/bin/sh
    trace_file="${SYMP_TEST_SSH_TRACE:-/tmp/symphony-workspace-cwd-ssh.trace}"
    printf 'ARGV:%s\\n' "$*" >> "$trace_file"
    eval "remote_cmd=\\${$#}"
    if printf '%s' "$remote_cmd" | grep -q "set -eu"; then
    #{indent(fake_ssh_case_script(command_behavior), 2)}
    else
    #{indent(fake_ssh_case_script(home_behavior), 2)}
    fi
    """
  end

  defp fake_ssh_case_script(:exec), do: "exec /bin/sh -c \"$remote_cmd\""

  defp fake_ssh_case_script({:output, value}) when is_binary(value) do
    """
    printf '%s\\n' #{SSH.shell_escape(value)}
    exit 0
    """
  end

  defp fake_ssh_case_script({:status, status, output})
       when is_integer(status) and is_binary(output) do
    """
    printf '%s\\n' #{SSH.shell_escape(output)}
    exit #{status}
    """
  end

  defp indent(text, spaces) when is_binary(text) and is_integer(spaces) do
    prefix = String.duplicate(" ", spaces)

    text
    |> String.split("\n")
    |> Enum.map_join("\n", fn
      "" -> ""
      line -> prefix <> line
    end)
  end
end
