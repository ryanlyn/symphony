defmodule SymphonyElixir.HttpServer do
  @moduledoc """
  Compatibility facade that starts the Phoenix observability endpoint when enabled.
  """

  alias SymphonyElixir.{Config, Orchestrator}
  alias SymphonyElixirWeb.Endpoint

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [opts]}
    }
  end

  @spec start_link(keyword()) :: GenServer.on_start() | :ignore
  def start_link(opts \\ []) do
    case Keyword.get(opts, :port, Config.server_port()) do
      port when is_integer(port) and port >= 0 ->
        host = Keyword.get(opts, :host, Config.settings!().server.host)
        orchestrator = Keyword.get(opts, :orchestrator, Orchestrator)
        snapshot_timeout_ms = Keyword.get(opts, :snapshot_timeout_ms, 15_000)

        with {:ok, ip} <- parse_host(host) do
          endpoint_opts = [
            server: true,
            http: [ip: ip, port: port],
            url: [host: normalize_host(host)],
            orchestrator: orchestrator,
            snapshot_timeout_ms: snapshot_timeout_ms
          ]

          endpoint_config =
            :symphony_elixir
            |> Application.get_env(Endpoint, [])
            |> Keyword.merge(endpoint_opts)

          Application.put_env(:symphony_elixir, Endpoint, endpoint_config)
          Endpoint.start_link()
        end

      _ ->
        :ignore
    end
  end

  @spec ensure_started(keyword()) ::
          {:ok, %{host: String.t(), port: pos_integer()}} | {:error, term()}
  def ensure_started(opts \\ []) do
    with :ok <- maybe_restart_http_server(opts),
         port when is_integer(port) and port > 0 <- wait_for_bound_port() do
      {:ok, %{host: Config.settings!().server.host, port: port}}
    else
      nil -> {:error, :http_server_not_running}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec bound_port(term()) :: non_neg_integer() | nil
  def bound_port(_server \\ __MODULE__) do
    case Bandit.PhoenixAdapter.server_info(Endpoint, :http) do
      {:ok, {_ip, port}} when is_integer(port) -> port
      _ -> nil
    end
  rescue
    _error -> nil
  catch
    :exit, _reason -> nil
  end

  @spec local_url(String.t(), pos_integer()) :: String.t()
  def local_url(path, port) when is_binary(path) and is_integer(port) and port > 0 do
    "http://#{url_host(Config.settings!().server.host)}:#{port}#{path}"
  end

  defp maybe_restart_http_server(opts) do
    maybe_set_port_override(opts)

    if running_http_server?(), do: :ok, else: start_or_restart_http_server()
  end

  defp maybe_set_port_override(opts) when is_list(opts) do
    case Keyword.get(opts, :port) do
      port when is_integer(port) and port >= 0 ->
        Application.put_env(:symphony_elixir, :server_port_override, port)
        :ok

      _ ->
        :ok
    end
  end

  defp running_http_server? do
    case bound_port() do
      port when is_integer(port) and port > 0 -> true
      _ -> false
    end
  end

  defp start_or_restart_http_server do
    case Process.whereis(SymphonyElixir.Supervisor) do
      nil -> start_http_server()
      _pid -> restart_supervised_http_server()
    end
  end

  defp start_http_server do
    case start_link() do
      {:ok, _pid} -> :ok
      :ignore -> {:error, :http_server_not_running}
      {:error, reason} -> {:error, reason}
    end
  end

  defp restart_supervised_http_server do
    case Supervisor.restart_child(SymphonyElixir.Supervisor, __MODULE__) do
      {:ok, _pid} -> :ok
      {:ok, _pid, _info} -> :ok
      {:error, :running} -> :ok
      {:error, {:already_started, _pid}} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp wait_for_bound_port(attempts \\ 40)

  defp wait_for_bound_port(attempts) when attempts > 0 do
    case bound_port() do
      port when is_integer(port) and port > 0 ->
        port

      _ ->
        Process.sleep(25)
        wait_for_bound_port(attempts - 1)
    end
  end

  defp wait_for_bound_port(0), do: nil

  defp parse_host({_, _, _, _} = ip), do: {:ok, ip}
  defp parse_host({_, _, _, _, _, _, _, _} = ip), do: {:ok, ip}

  defp parse_host(host) when is_binary(host) do
    charhost = String.to_charlist(host)

    case :inet.parse_address(charhost) do
      {:ok, ip} ->
        {:ok, ip}

      {:error, _reason} ->
        case :inet.getaddr(charhost, :inet) do
          {:ok, ip} -> {:ok, ip}
          {:error, _reason} -> :inet.getaddr(charhost, :inet6)
        end
    end
  end

  defp normalize_host(host) when host in ["", nil], do: "127.0.0.1"
  defp normalize_host(host) when is_binary(host), do: host
  defp normalize_host(host), do: to_string(host)

  defp url_host(host) when host in ["", nil], do: "127.0.0.1"

  defp url_host(host) when is_binary(host) do
    if String.contains?(host, ":"), do: "[#{host}]", else: host
  end

  defp url_host(host), do: to_string(host)
end
