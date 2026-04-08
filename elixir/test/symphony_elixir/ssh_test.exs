defmodule SymphonyElixir.SSHTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.FakeSshSupport
  alias SymphonyElixir.SSH

  test "run/3 keeps bracketed IPv6 host:port targets intact" do
    test_root =
      Path.join(System.tmp_dir!(), "symphony-ssh-ipv6-test-#{System.unique_integer([:positive])}")

    trace_file = Path.join(test_root, "ssh.trace")
    previous_path = System.get_env("PATH")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh!(test_root, trace_file)

    assert {:ok, {"", 0}} =
             SSH.run("root@[::1]:2200", "printf ok", stderr_to_stdout: true)

    trace = File.read!(trace_file)
    assert trace =~ "-T -p 2200 root@[::1] bash -lc"
    assert trace =~ "printf ok"
  end

  test "run/3 leaves unbracketed IPv6-style targets unchanged" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-ssh-ipv6-raw-test-#{System.unique_integer([:positive])}"
      )

    trace_file = Path.join(test_root, "ssh.trace")
    previous_path = System.get_env("PATH")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh!(test_root, trace_file)

    assert {:ok, {"", 0}} =
             SSH.run("::1:2200", "printf ok", stderr_to_stdout: true)

    trace = File.read!(trace_file)
    assert trace =~ "-T ::1:2200 bash -lc"
    refute trace =~ "-p 2200"
  end

  test "run/3 passes host:port targets through ssh -p" do
    test_root =
      Path.join(System.tmp_dir!(), "symphony-ssh-test-#{System.unique_integer([:positive])}")

    trace_file = Path.join(test_root, "ssh.trace")
    previous_path = System.get_env("PATH")
    previous_ssh_config = System.get_env("SYMPHONY_SSH_CONFIG")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      restore_env("SYMPHONY_SSH_CONFIG", previous_ssh_config)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh!(test_root, trace_file)
    System.put_env("SYMPHONY_SSH_CONFIG", "/tmp/symphony-test-ssh-config")

    assert {:ok, {"", 0}} =
             SSH.run("localhost:2222", "echo ready", stderr_to_stdout: true)

    trace = File.read!(trace_file)
    assert trace =~ "-F /tmp/symphony-test-ssh-config"
    assert trace =~ "-T -p 2222 localhost bash -lc"
    assert trace =~ "echo ready"
  end

  test "run/3 keeps the user prefix when parsing user@host:port targets" do
    test_root =
      Path.join(System.tmp_dir!(), "symphony-ssh-user-test-#{System.unique_integer([:positive])}")

    trace_file = Path.join(test_root, "ssh.trace")
    previous_path = System.get_env("PATH")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh!(test_root, trace_file)

    assert {:ok, {"", 0}} =
             SSH.run("root@127.0.0.1:2200", "printf ok", stderr_to_stdout: true)

    trace = File.read!(trace_file)
    assert trace =~ "-T -p 2200 root@127.0.0.1 bash -lc"
    assert trace =~ "printf ok"
  end

  test "run/3 returns an error when ssh is unavailable" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-ssh-missing-test-#{System.unique_integer([:positive])}"
      )

    previous_path = System.get_env("PATH")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      File.rm_rf(test_root)
    end)

    File.mkdir_p!(test_root)
    System.put_env("PATH", test_root)

    assert {:error, :ssh_not_found} = SSH.run("localhost", "printf ok")
  end

  test "run/3 returns a timeout error when ssh exceeds the caller timeout" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-ssh-timeout-test-#{System.unique_integer([:positive])}"
      )

    trace_file = Path.join(test_root, "ssh.trace")
    previous_path = System.get_env("PATH")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh!(test_root, trace_file, """
    #!/bin/sh
    printf 'ARGV:%s\\n' "$*" >> "#{trace_file}"
    sleep 1
    exit 0
    """)

    assert {:error, {:ssh_timeout, "localhost", 10}} =
             SSH.run("localhost", "printf ok", stderr_to_stdout: true, timeout: 10)

    FakeSshSupport.wait_for_trace!(trace_file)
    trace = File.read!(trace_file)
    assert trace =~ "-T localhost bash -lc"
    assert trace =~ "printf ok"
  end

  test "start_port/3 supports binary output without line mode" do
    test_root =
      Path.join(System.tmp_dir!(), "symphony-ssh-port-test-#{System.unique_integer([:positive])}")

    trace_file = Path.join(test_root, "ssh.trace")
    previous_path = System.get_env("PATH")
    previous_ssh_config = System.get_env("SYMPHONY_SSH_CONFIG")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      restore_env("SYMPHONY_SSH_CONFIG", previous_ssh_config)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh!(test_root, trace_file, """
    #!/bin/sh
    printf 'ARGV:%s\\n' "$*" >> "#{trace_file}"
    printf 'ready\\n'
    exit 0
    """)

    System.delete_env("SYMPHONY_SSH_CONFIG")

    assert {:ok, port} = SSH.start_port("localhost", "printf ok")
    assert is_port(port)
    FakeSshSupport.wait_for_trace!(trace_file)

    trace = File.read!(trace_file)
    assert trace =~ "-T localhost bash -lc"
    refute trace =~ " -F "
  end

  test "start_port/3 supports line mode" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-ssh-line-port-test-#{System.unique_integer([:positive])}"
      )

    trace_file = Path.join(test_root, "ssh.trace")
    previous_path = System.get_env("PATH")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh!(test_root, trace_file, """
    #!/bin/sh
    printf 'ARGV:%s\\n' "$*" >> "#{trace_file}"
    printf 'ready\\n'
    exit 0
    """)

    assert {:ok, port} = SSH.start_port("localhost:2222", "printf ok", line: 256)
    assert is_port(port)
    FakeSshSupport.wait_for_trace!(trace_file)

    trace = File.read!(trace_file)
    assert trace =~ "-T -p 2222 localhost bash -lc"
  end

  test "remote_shell_command/1 escapes embedded single quotes" do
    assert SSH.remote_shell_command("printf 'hello'") ==
             "bash -lc 'printf '\"'\"'hello'\"'\"''"
  end

  test "write_file/4 preserves shebang-prefixed payloads without a leading newline" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-ssh-write-file-shebang-test-#{System.unique_integer([:positive])}"
      )

    trace_file = Path.join(test_root, "ssh.trace")
    output_file = Path.join(test_root, "script.sh")
    previous_path = System.get_env("PATH")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh_with_eval!(test_root, trace_file)

    payload = "#!/bin/bash\necho ready\n"

    assert :ok = SSH.write_file("localhost", output_file, payload, mode: 0o755)
    written_contents = File.read!(output_file)
    assert written_contents == payload
    assert {:ok, stat} = File.stat(output_file)
    assert :erlang.band(stat.mode, 0o777) == 0o755

    trace = File.read!(trace_file)
    assert trace =~ "printf"
    assert trace =~ "%s"
  end

  test "write_file/4 preserves delimiter-shaped payload lines without execution" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-ssh-write-file-test-#{System.unique_integer([:positive])}"
      )

    trace_file = Path.join(test_root, "ssh.trace")
    output_file = Path.join(test_root, "written.txt")
    probe_file = Path.join(test_root, "pwned")
    previous_path = System.get_env("PATH")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh_with_eval!(test_root, trace_file)

    payload = """
    first line
    __SYMPHONY_SSH_WRITE_PAYLOAD__
    touch #{probe_file}
    second line
    """

    assert :ok = SSH.write_file("localhost", output_file, payload, mode: 0o640)
    assert File.read!(output_file) == payload
    refute File.exists?(probe_file)
    assert {:ok, stat} = File.stat(output_file)
    assert :erlang.band(stat.mode, 0o777) == 0o640

    trace = File.read!(trace_file)
    refute trace =~ "cat <<'__SYMPHONY_SSH_WRITE_PAYLOAD__' >"
    assert trace =~ "printf"
    assert trace =~ "%s"
    assert trace =~ "__SYMPHONY_SSH_WRITE_PAYLOAD__"
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
