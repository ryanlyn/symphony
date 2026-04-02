defmodule SymphonyElixir.Claude.CapabilityProbe do
  @moduledoc false

  alias SymphonyElixir.{Config, SSH}

  defstruct [
    :command,
    :version,
    print: false,
    stream_json: false,
    verbose: false,
    resume: false,
    permission_mode: false,
    model: false,
    mcp_config: false,
    strict_mcp_config: false,
    input_format: false
  ]

  @type t :: %__MODULE__{
          command: String.t(),
          version: String.t() | nil,
          print: boolean(),
          stream_json: boolean(),
          verbose: boolean(),
          resume: boolean(),
          permission_mode: boolean(),
          model: boolean(),
          mcp_config: boolean(),
          strict_mcp_config: boolean(),
          input_format: boolean()
        }

  @spec probe(keyword()) :: {:ok, t()} | {:error, term()}
  def probe(opts \\ []) do
    command = Keyword.get(opts, :command, Config.settings!().claude.command)
    worker_host = Keyword.get(opts, :worker_host)
    runner = Keyword.get(opts, :runner, &command_output/3)
    cache_key = {__MODULE__, command, worker_host || :local}

    if Keyword.has_key?(opts, :runner) do
      probe_uncached(command, worker_host, runner)
    else
      case :persistent_term.get(cache_key, :missing) do
        {:ok, capabilities} ->
          {:ok, capabilities}

        :missing ->
          case probe_uncached(command, worker_host, runner) do
            {:ok, capabilities} = result ->
              :persistent_term.put(cache_key, result)
              {:ok, capabilities}

            {:error, _reason} = error ->
              error
          end
      end
    end
  end

  defp probe_uncached(command, worker_host, runner)
       when is_binary(command) and is_function(runner, 3) do
    with {:ok, help_output} <- runner.(command, ["--help"], worker_host),
         {:ok, version_output} <- runner.(command, ["--version"], worker_host) do
      {:ok,
       %__MODULE__{
         command: command,
         version: String.trim(version_output),
         print: String.contains?(help_output, "--print"),
         stream_json: String.contains?(help_output, "--output-format <format>"),
         verbose: String.contains?(help_output, "--verbose"),
         resume: String.contains?(help_output, "--resume"),
         permission_mode: String.contains?(help_output, "--permission-mode <mode>"),
         model: String.contains?(help_output, "--model <model>"),
         mcp_config: String.contains?(help_output, "--mcp-config <configs...>"),
         strict_mcp_config: String.contains?(help_output, "--strict-mcp-config"),
         input_format: String.contains?(help_output, "--input-format <format>")
       }}
    end
  end

  @spec command_output(String.t(), [String.t()], String.t() | nil) :: {:ok, String.t()} | {:error, term()}
  def command_output(command, args, nil) when is_binary(command) and is_list(args) do
    shell_command =
      [command | Enum.map(args, &SSH.shell_escape/1)]
      |> Enum.join(" ")

    case System.cmd("bash", ["-lc", shell_command], stderr_to_stdout: true) do
      {output, 0} -> {:ok, output}
      {output, status} -> {:error, {:probe_command_failed, status, output}}
    end
  end

  def command_output(command, args, worker_host)
      when is_binary(command) and is_list(args) and is_binary(worker_host) do
    shell_command =
      [command | Enum.map(args, &SSH.shell_escape/1)]
      |> Enum.join(" ")

    case SSH.run(worker_host, shell_command, stderr_to_stdout: true) do
      {:ok, {output, 0}} -> {:ok, output}
      {:ok, {output, status}} -> {:error, {:probe_command_failed, status, output}}
      {:error, reason} -> {:error, reason}
    end
  end
end
