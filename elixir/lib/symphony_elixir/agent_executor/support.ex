defmodule SymphonyElixir.AgentExecutor.Support do
  @moduledoc false

  alias SymphonyElixir.SSH

  @spec port_metadata(port(), atom(), String.t() | nil) :: map()
  def port_metadata(port, pid_key, worker_host) when is_port(port) and is_atom(pid_key) do
    base_metadata =
      case :erlang.port_info(port, :os_pid) do
        {:os_pid, os_pid} -> %{pid_key => Integer.to_string(os_pid)}
        _ -> %{}
      end

    case worker_host do
      host when is_binary(host) -> Map.put(base_metadata, :worker_host, host)
      _ -> base_metadata
    end
  end

  @spec stop_port(port()) :: :ok
  def stop_port(port) when is_port(port) do
    Port.close(port)
    :ok
  rescue
    ArgumentError ->
      :ok
  end

  @spec shell_escape(String.t()) :: String.t()
  def shell_escape(value) when is_binary(value), do: SSH.shell_escape(value)
end
