defmodule SymphonyElixir.Codex.ResumeState do
  @moduledoc false

  alias SymphonyElixir.AgentResumeState

  @type state :: AgentResumeState.state()

  @spec read(Path.t()) :: {:ok, state()} | :missing | {:error, term()}
  def read(workspace) when is_binary(workspace), do: AgentResumeState.read(workspace)

  @spec read(Path.t(), String.t() | nil) :: {:ok, state()} | :missing | {:error, term()}
  def read(workspace, worker_host) when is_binary(workspace) do
    AgentResumeState.read(workspace, worker_host)
  end

  @spec write(Path.t(), map()) :: :ok | {:error, term()}
  def write(workspace, attrs) when is_binary(workspace) and is_map(attrs) do
    AgentResumeState.write(workspace, attrs)
  end

  @spec write(Path.t(), map(), String.t() | nil) :: :ok | {:error, term()}
  def write(workspace, attrs, worker_host) when is_binary(workspace) and is_map(attrs) do
    AgentResumeState.write(workspace, attrs, worker_host)
  end

  @spec delete(Path.t()) :: :ok | {:error, term()}
  def delete(workspace) when is_binary(workspace), do: AgentResumeState.delete(workspace)

  @spec delete(Path.t(), String.t() | nil) :: :ok | {:error, term()}
  def delete(workspace, worker_host) when is_binary(workspace) do
    AgentResumeState.delete(workspace, worker_host)
  end
end
