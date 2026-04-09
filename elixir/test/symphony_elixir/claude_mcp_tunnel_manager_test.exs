defmodule SymphonyElixir.ClaudeMcpTunnelManagerTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Claude.McpTunnelManager
  alias SymphonyElixir.FakeSshSupport
  import SymphonyElixir.TestSupport, only: [restore_env: 2]

  test "shared tunnel is reused while multiple consumers remain on the same worker host" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-claude-mcp-tunnel-#{System.unique_integer([:positive])}"
      )

    trace_file = Path.join(test_root, "ssh.trace")
    previous_path = System.get_env("PATH")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh!(test_root, trace_file, fake_tunnel_ssh_script(trace_file))

    assert {:ok, remote_port} = McpTunnelManager.acquire("worker-shared-1", "127.0.0.1", 41_000)
    assert {:ok, ^remote_port} = McpTunnelManager.acquire("worker-shared-1", "127.0.0.1", 41_000)
    FakeSshSupport.wait_for_trace!(trace_file)

    assert length(
             Regex.scan(
               ~r/-R #{remote_port}:127\.0\.0\.1:41000 worker-shared-1/m,
               File.read!(trace_file)
             )
           ) == 1

    assert :ok = McpTunnelManager.release("worker-shared-1")
    assert {:ok, ^remote_port} = McpTunnelManager.acquire("worker-shared-1", "127.0.0.1", 41_000)

    assert length(
             Regex.scan(
               ~r/-R #{remote_port}:127\.0\.0\.1:41000 worker-shared-1/m,
               File.read!(trace_file)
             )
           ) == 1

    assert :ok = McpTunnelManager.release("worker-shared-1")
    assert :ok = McpTunnelManager.release("worker-shared-1")
  end

  test "tunnel is recreated when the forwarded local port changes" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-claude-mcp-tunnel-port-change-#{System.unique_integer([:positive])}"
      )

    trace_file = Path.join(test_root, "ssh.trace")
    previous_path = System.get_env("PATH")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh!(test_root, trace_file, fake_tunnel_ssh_script(trace_file))

    assert {:ok, first_remote_port} =
             McpTunnelManager.acquire("worker-shared-2", "127.0.0.1", 41_000)

    assert :ok = McpTunnelManager.release("worker-shared-2")

    assert {:ok, second_remote_port} =
             McpTunnelManager.acquire("worker-shared-2", "127.0.0.1", 41_001)

    assert_eventually(
      fn ->
        trace = if File.exists?(trace_file), do: File.read!(trace_file), else: ""

        trace =~ "-R #{first_remote_port}:127.0.0.1:41000 worker-shared-2" and
          trace =~ "-R #{second_remote_port}:127.0.0.1:41001 worker-shared-2"
      end,
      200
    )

    assert :ok = McpTunnelManager.release("worker-shared-2")
  end

  test "dead tunnel processes are rebuilt on the next acquire" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-claude-mcp-tunnel-dead-#{System.unique_integer([:positive])}"
      )

    trace_file = Path.join(test_root, "ssh.trace")
    previous_path = System.get_env("PATH")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      File.rm_rf(test_root)
    end)

    FakeSshSupport.install_fake_ssh!(test_root, trace_file, fake_tunnel_ssh_script(trace_file))

    assert {:ok, remote_port} = McpTunnelManager.acquire("worker-shared-3", "127.0.0.1", 41_000)
    FakeSshSupport.wait_for_trace!(trace_file)
    old_tunnel_port = :sys.get_state(McpTunnelManager).tunnels["worker-shared-3"].port
    send(McpTunnelManager, {old_tunnel_port, {:exit_status, 0}})

    assert_eventually(fn ->
      is_nil(:sys.get_state(McpTunnelManager).tunnels["worker-shared-3"])
    end)

    assert {:ok, ^remote_port} = McpTunnelManager.acquire("worker-shared-3", "127.0.0.1", 41_000)
    new_tunnel_port = :sys.get_state(McpTunnelManager).tunnels["worker-shared-3"].port
    refute new_tunnel_port == old_tunnel_port

    assert :ok = McpTunnelManager.release("worker-shared-3")
  end

  defp fake_tunnel_ssh_script(trace_file) when is_binary(trace_file) do
    """
    #!/bin/sh
    printf 'ARGV:%s\\n' "$*" >> "#{trace_file}"

    case "$*" in
      *" -N "*)
        while true; do
          sleep 1
        done
        ;;
      *)
        exit 0
        ;;
    esac
    """
  end

  defp assert_eventually(fun, attempts \\ 20)

  defp assert_eventually(fun, attempts) when attempts > 0 do
    if fun.() do
      :ok
    else
      Process.sleep(10)
      assert_eventually(fun, attempts - 1)
    end
  end

  defp assert_eventually(_fun, 0), do: flunk("condition not met in time")
end
