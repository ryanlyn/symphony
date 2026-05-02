defmodule SymphonyElixir.WorkspaceAfterCreateHookFailureTest do
  # Exhaustive probe of how `Workspace.create_for_issue/3` behaves when the
  # configured `after_create` hook errors out or hangs.
  #
  # Each test isolates one failure mode and asserts both the immediate return
  # value AND the residual filesystem / recovery state, so any "left in a bad
  # state" or orphan-process behaviour is surfaced rather than silently
  # accepted.
  use SymphonyElixir.TestSupport

  defp setup_workspace_root(slug) do
    root =
      Path.join(
        System.tmp_dir!(),
        "symphony-after-create-#{slug}-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf(root) end)
    root
  end

  defp pid_alive?(""), do: false

  defp pid_alive?(pid) when is_binary(pid) do
    case System.cmd("kill", ["-0", pid], stderr_to_stdout: true) do
      {_, 0} -> true
      _ -> false
    end
  end

  defp force_kill(""), do: :ok

  defp force_kill(pid) when is_binary(pid) do
    _ = System.cmd("kill", ["-9", pid], stderr_to_stdout: true)
    :ok
  end

  # Polls until `pid_file` is non-empty (or gives up); returns the trimmed pid
  # or "" on timeout.
  defp read_pid(pid_file) do
    Enum.reduce_while(1..40, "", fn _, _ ->
      case File.read(pid_file) do
        {:ok, contents} ->
          trimmed = String.trim(contents)
          if trimmed == "", do: {:cont, ""}, else: {:halt, trimmed}

        _ ->
          Process.sleep(50)
          {:cont, ""}
      end
    end)
  end

  # Returns true if the pid is still alive after polling for up to `budget_ms`.
  defp wait_for_death(pid, budget_ms) do
    deadline = System.monotonic_time(:millisecond) + budget_ms

    Stream.repeatedly(fn -> :tick end)
    |> Enum.reduce_while(true, fn _, _ ->
      cond do
        not pid_alive?(pid) -> {:halt, false}
        System.monotonic_time(:millisecond) >= deadline -> {:halt, pid_alive?(pid)}
        true -> Process.sleep(50); {:cont, true}
      end
    end)
  end

  describe "baseline" do
    test "successful hook runs once and creates the workspace" do
      workspace_root = setup_workspace_root("baseline-ok")
      counter = Path.join(workspace_root, "_runs")
      File.write!(counter, "")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "echo run >> #{counter}; touch ok.txt"
      )

      assert {:ok, workspace} = Workspace.create_for_issue("AC-OK")
      assert File.exists?(Path.join(workspace, "ok.txt"))
      assert File.read!(counter) == "run\n"
    end
  end

  describe "non-zero exit" do
    test "returns {:workspace_hook_failed, \"after_create\", status, output}" do
      workspace_root = setup_workspace_root("nonzero")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "echo boom; exit 17"
      )

      assert {:error, {:workspace_hook_failed, "after_create", 17, output}} =
               Workspace.create_for_issue("AC-FAIL-1")

      assert output =~ "boom"
    end

    test "no automatic retry: hook is invoked exactly once" do
      workspace_root = setup_workspace_root("no-retry")
      counter = Path.join(workspace_root, "_runs")
      File.write!(counter, "")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "echo run >> #{counter}; exit 7"
      )

      assert {:error, {:workspace_hook_failed, "after_create", 7, _}} =
               Workspace.create_for_issue("AC-NORETRY")

      assert File.read!(counter) == "run\n"
    end

    test "leaves workspace directory (with partial side effects) on disk" do
      workspace_root = setup_workspace_root("leftover")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "touch partial.txt; exit 1"
      )

      assert {:error, {:workspace_hook_failed, "after_create", 1, _}} =
               Workspace.create_for_issue("AC-LEFTOVER")

      expected = Path.join(workspace_root, "AC-LEFTOVER")
      assert File.dir?(expected),
             "workspace dir should still exist on disk after a failed hook"
      assert File.exists?(Path.join(expected, "partial.txt")),
             "partial side effects from the failed hook are left in the workspace"
    end

    test "BAD STATE: a second create_for_issue silently succeeds and skips the hook" do
      # This is the central recovery question: after a hook failure leaves a
      # half-bootstrapped workspace, does symphony detect the bad state on
      # retry? Answer (current code): NO. ensure_workspace sees the directory
      # already exists, returns created? = false, and maybe_run_after_create_hook
      # short-circuits to :ok. The caller gets {:ok, workspace} for a workspace
      # that was never bootstrapped.
      workspace_root = setup_workspace_root("retry-skip")
      counter = Path.join(workspace_root, "_runs")
      File.write!(counter, "")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "echo run >> #{counter}; touch sentinel-$(wc -l < #{counter} | tr -d ' '); exit 1"
      )

      assert {:error, {:workspace_hook_failed, "after_create", 1, _}} =
               Workspace.create_for_issue("AC-RETRY")

      assert File.read!(counter) == "run\n"

      assert {:ok, workspace} = Workspace.create_for_issue("AC-RETRY"),
             "second call returns :ok despite the workspace never being bootstrapped"

      assert File.read!(counter) == "run\n",
             "after_create hook was silently skipped on the retry"

      refute File.exists?(Path.join(workspace, "sentinel-2")),
             "no second-run sentinel exists; the hook was not re-executed"
    end

    test "manual workspace removal is the only documented recovery path" do
      workspace_root = setup_workspace_root("manual-recover")
      counter = Path.join(workspace_root, "_runs")
      File.write!(counter, "")
      flag = Path.join(workspace_root, "_first")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: """
        echo run >> #{counter}
        if [ -e #{flag} ]; then exit 0; fi
        touch #{flag}
        exit 9
        """
      )

      assert {:error, {:workspace_hook_failed, "after_create", 9, _}} =
               Workspace.create_for_issue("AC-MANUAL")

      File.rm_rf!(Path.join(workspace_root, "AC-MANUAL"))

      assert {:ok, _} = Workspace.create_for_issue("AC-MANUAL")
      assert File.read!(counter) == "run\nrun\n",
             "after manual rm of the workspace, the hook is re-run on the next call"
    end

    test "command-not-found is surfaced as a non-zero exit (typically 127)" do
      workspace_root = setup_workspace_root("missing-cmd")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "definitely_not_a_command_zzz_#{System.unique_integer([:positive])}"
      )

      assert {:error, {:workspace_hook_failed, "after_create", status, output}} =
               Workspace.create_for_issue("AC-MISS")

      assert status != 0
      assert output =~ ~r/not found|command not found/i
    end

    test "very large hook output is fully captured but truncated in the log line" do
      workspace_root = setup_workspace_root("big-output")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "yes x | head -c 65536; exit 1"
      )

      {result, log} =
        ExUnit.CaptureLog.with_log(fn -> Workspace.create_for_issue("AC-BIG") end)

      assert {:error, {:workspace_hook_failed, "after_create", 1, output}} = result
      assert byte_size(output) >= 60_000,
             "full hook output is preserved in the error tuple"
      assert log =~ "(truncated)",
             "log line is bounded by sanitize_hook_output_for_log/2"
    end

    test "concurrent failing hooks for different issues fail independently" do
      workspace_root = setup_workspace_root("concurrent")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "exit 5"
      )

      results =
        1..4
        |> Enum.map(fn i ->
          Task.async(fn -> Workspace.create_for_issue("CON-#{i}") end)
        end)
        |> Enum.map(&Task.await(&1, 30_000))

      Enum.each(results, fn r ->
        assert {:error, {:workspace_hook_failed, "after_create", 5, _}} = r
      end)

      for i <- 1..4 do
        assert File.dir?(Path.join(workspace_root, "CON-#{i}")),
               "each failing issue still leaves its own workspace dir behind"
      end
    end
  end

  describe "timeout / hang" do
    test "returns {:workspace_hook_timeout, ...} promptly" do
      workspace_root = setup_workspace_root("timeout")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_timeout_ms: 50,
        hook_after_create: "sleep 30"
      )

      started = System.monotonic_time(:millisecond)

      assert {:error, {:workspace_hook_timeout, "after_create", 50}} =
               Workspace.create_for_issue("AC-TO")

      elapsed = System.monotonic_time(:millisecond) - started
      assert elapsed < 5_000,
             "create_for_issue blocked for #{elapsed}ms; timeout did not fire promptly"
    end

    test "BAD STATE: a second create_for_issue silently succeeds and skips the hung hook" do
      # The timeout has to be large enough for `bash -lc` to actually start
      # and write the marker before getting killed; 50 ms is too tight when
      # bash is sourcing /etc/profile et al. 1 s is generous and `sleep 30`
      # still triggers the timeout deterministically.
      workspace_root = setup_workspace_root("timeout-retry")
      marker = Path.join(workspace_root, "_marker")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_timeout_ms: 1_000,
        hook_after_create: "echo started > #{marker}; sleep 30"
      )

      assert {:error, {:workspace_hook_timeout, "after_create", 1_000}} =
               Workspace.create_for_issue("AC-TO-RETRY")

      # Wait briefly in case the marker write races the timeout return.
      Enum.reduce_while(1..20, nil, fn _, _ ->
        if File.exists?(marker), do: {:halt, :ok}, else: (Process.sleep(50); {:cont, nil})
      end)

      assert File.read!(marker) == "started\n"

      assert {:ok, workspace} = Workspace.create_for_issue("AC-TO-RETRY"),
             "second call returns :ok despite the hook never completing"

      assert File.dir?(workspace)
      assert File.read!(marker) == "started\n",
             "hook was not re-run; the half-bootstrapped workspace is silently reused"
    end

    test "PROBE: foreground hook process lifetime after timeout" do
      # Probes whether `Task.shutdown(:brutal_kill)` actually reaps the OS
      # shell `bash -lc` that `System.cmd` spawned. In the symphony source,
      # workspace.ex:372 brutal-kills the BEAM Task, which closes the port —
      # but on stock OTP that does NOT signal the OS process group. So the
      # bash + its `sleep 60` typically keep running for the full sleep
      # duration after symphony returns its timeout error.
      workspace_root = setup_workspace_root("kill-fg")
      pid_file = Path.join(workspace_root, "_pid")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_timeout_ms: 100,
        hook_after_create: "echo $$ > #{pid_file}; sleep 60"
      )

      assert {:error, {:workspace_hook_timeout, "after_create", 100}} =
               Workspace.create_for_issue("AC-FG")

      pid = read_pid(pid_file)
      survived? = wait_for_death(pid, 2_000)
      force_kill(pid)

      if survived? do
        IO.puts(
          :stderr,
          "BRUTAL_KILL-LEAK FINDING: foreground hook bash pid #{pid} was still " <>
            "alive >2s after Workspace.create_for_issue/3 returned a timeout error. " <>
            "Task.shutdown(:brutal_kill) closes the BEAM port but does not signal " <>
            "the spawned OS process; the shell + its `sleep 60` survive the hook timeout."
        )
      end
    end

    test "PROBE: SIGTERM-trapping hook lifetime after timeout" do
      # Even if symphony tried to escalate via SIGTERM, a hook can `trap ''`
      # it. SIGKILL cannot be trapped — but symphony does not appear to send
      # any signal at all, so trapping is moot. This probe documents that.
      workspace_root = setup_workspace_root("sigterm-trap")
      pid_file = Path.join(workspace_root, "_pid")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_timeout_ms: 100,
        hook_after_create: "trap '' TERM INT HUP; echo $$ > #{pid_file}; sleep 60"
      )

      assert {:error, {:workspace_hook_timeout, "after_create", 100}} =
               Workspace.create_for_issue("AC-TRAP")

      pid = read_pid(pid_file)
      survived? = wait_for_death(pid, 2_000)
      force_kill(pid)

      if survived? do
        IO.puts(
          :stderr,
          "BRUTAL_KILL-LEAK FINDING: SIGTERM-trapping hook bash pid #{pid} survived " <>
            "the hook timeout. (Expected — SIGKILL would still terminate it, but " <>
            "symphony does not signal the OS process at all.)"
        )
      end
    end

    test "PROBE: setsid-detached descendants leak after a hook timeout" do
      # Demonstrates the practical orphan-leak surface: a hook that backgrounds
      # a daemon in a new session (e.g. a long-running watcher / file-syncer)
      # is not part of the BEAM port's tracked process group, so brutal_kill
      # only reaps the immediate child, and the daemon survives.
      #
      # The test asserts the symphony return path is unaffected; the orphan
      # status itself is reported as a finding without failing the suite,
      # since the exact behaviour depends on `setsid` availability.
      case System.find_executable("setsid") do
        nil ->
          IO.puts(:stderr, "skipping orphan probe: `setsid` not available")

        _ ->
          workspace_root = setup_workspace_root("orphan")
          orphan_pid = Path.join(workspace_root, "_orphan_pid")
          orphan_done = Path.join(workspace_root, "_orphan_done")

          write_workflow_file!(Workflow.workflow_file_path(),
            workspace_root: workspace_root,
            hook_timeout_ms: 100,
            hook_after_create: """
            ( setsid sh -c 'echo $$ > #{orphan_pid}; sleep 2; touch #{orphan_done}' </dev/null >/dev/null 2>&1 & )
            sleep 60
            """
          )

          started = System.monotonic_time(:millisecond)

          assert {:error, {:workspace_hook_timeout, "after_create", 100}} =
                   Workspace.create_for_issue("AC-ORPHAN")

          elapsed = System.monotonic_time(:millisecond) - started

          assert elapsed < 5_000,
                 "create_for_issue did not return promptly despite the orphan: #{elapsed}ms"

          # Wait long enough for the detached child to write its done marker.
          Process.sleep(2_500)

          pid =
            case File.read(orphan_pid) do
              {:ok, contents} -> String.trim(contents)
              _ -> ""
            end

          orphan_completed? = File.exists?(orphan_done)
          force_kill(pid)

          if orphan_completed? do
            IO.puts(
              :stderr,
              "ORPHAN-LEAK FINDING: setsid-detached child #{pid} ran to completion " <>
                "after the hook timed out. brutal_kill does not reap the whole " <>
                "process tree, so a daemon spawned in after_create can outlive a hook timeout."
            )
          end
      end
    end
  end
end
