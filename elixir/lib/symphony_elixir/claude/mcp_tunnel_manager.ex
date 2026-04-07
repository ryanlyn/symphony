defmodule SymphonyElixir.Claude.McpTunnelManager do
  @moduledoc false

  use GenServer

  alias SymphonyElixir.SSH

  @initial_remote_port 46_000

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [opts]}
    }
  end

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(
      __MODULE__,
      %{available_remote_ports: [], next_remote_port: @initial_remote_port, tunnels: %{}},
      Keyword.put_new(opts, :name, __MODULE__)
    )
  end

  @spec acquire(String.t(), String.t(), pos_integer()) :: {:ok, pos_integer()} | {:error, term()}
  def acquire(worker_host, local_host, local_port)
      when is_binary(worker_host) and is_binary(local_host) and is_integer(local_port) and
             local_port > 0 do
    GenServer.call(__MODULE__, {:acquire, worker_host, local_host, local_port})
  end

  @spec release(String.t()) :: :ok
  def release(worker_host) when is_binary(worker_host) do
    GenServer.call(__MODULE__, {:release, worker_host})
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:acquire, worker_host, local_host, local_port}, _from, state) do
    case Map.fetch(state.tunnels, worker_host) do
      {:ok, %{local_host: ^local_host, local_port: ^local_port} = tunnel} ->
        if Port.info(tunnel.port) do
          updated_tunnels =
            Map.put(state.tunnels, worker_host, %{tunnel | ref_count: tunnel.ref_count + 1})

          {:reply, {:ok, tunnel.remote_port}, %{state | tunnels: updated_tunnels}}
        else
          close_port(tunnel.port)

          create_tunnel(
            worker_host,
            local_host,
            local_port,
            recycle_tunnel(state, worker_host, tunnel)
          )
        end

      {:ok, tunnel} ->
        close_port(tunnel.port)

        create_tunnel(
          worker_host,
          local_host,
          local_port,
          recycle_tunnel(state, worker_host, tunnel)
        )

      :error ->
        create_tunnel(worker_host, local_host, local_port, state)
    end
  end

  def handle_call({:release, worker_host}, _from, state) do
    case Map.fetch(state.tunnels, worker_host) do
      {:ok, %{ref_count: 1, port: port}} ->
        close_port(port)
        {:reply, :ok, %{state | tunnels: Map.delete(state.tunnels, worker_host)}}

      {:ok, tunnel} ->
        updated_tunnels =
          Map.put(state.tunnels, worker_host, %{tunnel | ref_count: max(tunnel.ref_count - 1, 0)})

        {:reply, :ok, %{state | tunnels: updated_tunnels}}

      :error ->
        {:reply, :ok, state}
    end
  end

  @impl true
  def handle_info({port, {:exit_status, _status}}, state) when is_port(port) do
    case Enum.find(state.tunnels, fn {_worker_host, tunnel} -> tunnel.port == port end) do
      {worker_host, tunnel} ->
        {:noreply, recycle_tunnel(state, worker_host, tunnel)}

      nil ->
        {:noreply, state}
    end
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp close_port(port) when is_port(port) do
    Port.close(port)
    :ok
  catch
    :error, _reason -> :ok
  end

  defp create_tunnel(worker_host, local_host, local_port, state) do
    {remote_port, next_state} =
      case state.available_remote_ports do
        [port | rest] ->
          {port, %{state | available_remote_ports: rest}}

        [] ->
          {state.next_remote_port, %{state | next_remote_port: state.next_remote_port + 1}}
      end

    case SSH.start_reverse_tunnel(worker_host, remote_port, local_host, local_port) do
      {:ok, port} ->
        tunnel = %{
          local_host: local_host,
          local_port: local_port,
          port: port,
          ref_count: 1,
          remote_port: remote_port
        }

        new_state = %{
          next_state
          | tunnels: Map.put(next_state.tunnels, worker_host, tunnel)
        }

        {:reply, {:ok, remote_port}, new_state}

      {:error, reason} ->
        failed_state =
          if remote_port in next_state.available_remote_ports do
            next_state
          else
            %{
              next_state
              | available_remote_ports: Enum.sort([remote_port | next_state.available_remote_ports])
            }
          end

        {:reply, {:error, reason}, failed_state}
    end
  end

  defp recycle_tunnel(state, worker_host, tunnel) do
    %{
      state
      | available_remote_ports: Enum.sort([tunnel.remote_port | state.available_remote_ports]),
        tunnels: Map.delete(state.tunnels, worker_host)
    }
  end
end
