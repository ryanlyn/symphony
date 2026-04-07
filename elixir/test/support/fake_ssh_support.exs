defmodule SymphonyElixir.FakeSshSupport do
  @moduledoc false

  def install_fake_ssh!(test_root, trace_file, script \\ nil) do
    fake_bin_dir = Path.join(test_root, "bin")
    fake_ssh = Path.join(fake_bin_dir, "ssh")

    File.mkdir_p!(fake_bin_dir)

    File.write!(
      fake_ssh,
      script ||
        """
        #!/bin/sh
        printf 'ARGV:%s\\n' "$*" >> "#{trace_file}"
        exit 0
        """
    )

    File.chmod!(fake_ssh, 0o755)
    System.put_env("PATH", fake_bin_dir <> ":" <> (System.get_env("PATH") || ""))
  end

  def install_fake_ssh_with_eval!(test_root, trace_file) do
    install_fake_ssh!(
      test_root,
      trace_file,
      """
      #!/bin/sh
      printf 'ARGV:%s\\n' "$*" >> "#{trace_file}"
      for arg in "$@"; do
        last_arg="$arg"
      done
      eval "$last_arg"
      """
    )
  end

  def wait_for_trace!(trace_file, attempts \\ 100)

  def wait_for_trace!(trace_file, 0),
    do: raise("timed out waiting for fake ssh trace at #{trace_file}")

  def wait_for_trace!(trace_file, attempts) do
    if File.exists?(trace_file) and File.read!(trace_file) != "" do
      :ok
    else
      Process.sleep(25)
      wait_for_trace!(trace_file, attempts - 1)
    end
  end
end
