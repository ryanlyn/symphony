defmodule SymphonyElixir.LogFileTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias SymphonyElixir.LogFile

  test "default_log_file/0 uses the current working directory" do
    assert LogFile.default_log_file() == Path.join(File.cwd!(), "log/symphony.log")
  end

  test "default_log_file/1 builds the log path under a custom root" do
    assert LogFile.default_log_file("/tmp/symphony-logs") == "/tmp/symphony-logs/log/symphony.log"
  end

  test "configure/0 logs a warning and returns :ok when the log directory cannot be created" do
    tmpdir =
      Path.join(
        System.tmp_dir!(),
        "symphony-log-file-test-#{System.unique_integer([:positive, :monotonic])}"
      )

    blocker = Path.join(tmpdir, "blocker")
    log_file = Path.join([blocker, "symphony.log"])

    File.mkdir_p!(tmpdir)
    File.write!(blocker, "occupied")

    original_log_file = Application.get_env(:symphony_elixir, :log_file)
    Application.put_env(:symphony_elixir, :log_file, log_file)

    on_exit(fn ->
      if is_nil(original_log_file) do
        Application.delete_env(:symphony_elixir, :log_file)
      else
        Application.put_env(:symphony_elixir, :log_file, original_log_file)
      end

      File.rm_rf!(tmpdir)
    end)

    log =
      capture_log(fn ->
        assert :ok = LogFile.configure()
      end)

    assert log =~ "Failed to create rotating log file directory"
    assert log =~ ":enotdir"
  end
end
