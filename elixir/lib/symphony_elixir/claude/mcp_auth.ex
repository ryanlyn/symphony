defmodule SymphonyElixir.Claude.McpAuth do
  @moduledoc false

  use GenServer

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [opts]}
    }
  end

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, %{}, Keyword.put_new(opts, :name, __MODULE__))
  end

  @spec issue_token() :: {:ok, String.t()}
  def issue_token do
    GenServer.call(__MODULE__, :issue_token)
  end

  @spec validate_token(String.t()) :: :ok | :error
  def validate_token(token) when is_binary(token) do
    GenServer.call(__MODULE__, {:validate_token, token})
  end

  @spec revoke_token(String.t()) :: :ok
  def revoke_token(token) when is_binary(token) do
    GenServer.call(__MODULE__, {:revoke_token, token})
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call(:issue_token, _from, state) do
    token = :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)
    {:reply, {:ok, token}, Map.put(state, token, true)}
  end

  def handle_call({:validate_token, token}, _from, state) do
    reply =
      case Map.fetch(state, token) do
        {:ok, true} -> :ok
        :error -> :error
      end

    {:reply, reply, state}
  end

  def handle_call({:revoke_token, token}, _from, state) do
    {:reply, :ok, Map.delete(state, token)}
  end
end
