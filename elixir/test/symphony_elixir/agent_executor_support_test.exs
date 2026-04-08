defmodule SymphonyElixir.AgentExecutor.SupportTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.AgentExecutor.Support

  test "port_metadata includes the requested pid key and worker host" do
    port = open_idle_port!()

    metadata = Support.port_metadata(port, :executor_pid, "worker-remote-1")

    assert %{executor_pid: executor_pid, worker_host: "worker-remote-1"} = metadata
    assert is_binary(executor_pid)
    assert executor_pid != ""

    Support.stop_port(port)
    assert_port_closed(port)
  end

  test "port_metadata falls back to an empty map when the port is gone" do
    port = open_idle_port!()

    Support.stop_port(port)
    assert_port_closed(port)

    assert Support.port_metadata(port, :executor_pid, nil) == %{}
  end

  test "stop_port closes open ports and tolerates repeated calls" do
    port = open_idle_port!()

    assert :ok = Support.stop_port(port)
    assert_port_closed(port)
    assert :ok = Support.stop_port(port)
  end

  test "shell_escape reuses the shared SSH escaping rules" do
    assert Support.shell_escape("hello 'quoted' world") == "'hello '\"'\"'quoted'\"'\"' world'"
  end

  defp open_idle_port! do
    executable = System.find_executable("cat") || flunk("cat executable not found")

    Port.open({:spawn_executable, String.to_charlist(executable)}, [:binary, :exit_status])
  end

  defp assert_port_closed(port, attempts \\ 20)

  defp assert_port_closed(port, attempts) when attempts > 0 do
    case Port.info(port) do
      nil ->
        :ok

      _ ->
        Process.sleep(10)
        assert_port_closed(port, attempts - 1)
    end
  end

  defp assert_port_closed(_port, 0), do: flunk("port remained open")
end
