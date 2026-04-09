defmodule SymphonyElixir.ObservabilityPubSubTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixirWeb.ObservabilityPubSub

  test "subscribe and broadcast_update deliver dashboard updates" do
    assert :ok = ObservabilityPubSub.subscribe()
    assert :ok = ObservabilityPubSub.broadcast_update()
    assert_receive :observability_updated
  end

  test "broadcast_update is a no-op when pubsub is unavailable" do
    pubsub_child_id = Phoenix.PubSub.Supervisor

    on_exit(fn ->
      if Process.whereis(SymphonyElixir.PubSub) == nil do
        assert {:ok, _pid} =
                 Supervisor.restart_child(SymphonyElixir.Supervisor, pubsub_child_id)
      end
    end)

    assert is_pid(Process.whereis(SymphonyElixir.PubSub))
    assert :ok = Supervisor.terminate_child(SymphonyElixir.Supervisor, pubsub_child_id)
    refute Process.whereis(SymphonyElixir.PubSub)

    assert :ok = ObservabilityPubSub.broadcast_update()
  end

  test "subscribe returns an error when pubsub is unavailable" do
    pubsub_child_id = Phoenix.PubSub.Supervisor

    on_exit(fn ->
      if Process.whereis(SymphonyElixir.PubSub) == nil do
        assert {:ok, _pid} =
                 Supervisor.restart_child(SymphonyElixir.Supervisor, pubsub_child_id)
      end
    end)

    assert is_pid(Process.whereis(SymphonyElixir.PubSub))
    assert :ok = Supervisor.terminate_child(SymphonyElixir.Supervisor, pubsub_child_id)
    refute Process.whereis(SymphonyElixir.PubSub)

    assert {:error, :pubsub_unavailable} = ObservabilityPubSub.subscribe()
  end

  test "subscribe rescues invalid pubsub registrations" do
    pubsub_child_id = Phoenix.PubSub.Supervisor
    dummy = spawn(fn -> Process.sleep(:infinity) end)

    on_exit(fn ->
      if Process.alive?(dummy) do
        ref = Process.monitor(dummy)
        Process.exit(dummy, :kill)
        assert_receive {:DOWN, ^ref, :process, ^dummy, _reason}
      end

      if Process.whereis(SymphonyElixir.PubSub) == nil do
        assert {:ok, _pid} =
                 Supervisor.restart_child(SymphonyElixir.Supervisor, pubsub_child_id)
      end
    end)

    assert is_pid(Process.whereis(SymphonyElixir.PubSub))
    assert :ok = Supervisor.terminate_child(SymphonyElixir.Supervisor, pubsub_child_id)
    refute Process.whereis(SymphonyElixir.PubSub)

    assert true = Process.register(dummy, SymphonyElixir.PubSub)
    assert {:error, :pubsub_unavailable} = ObservabilityPubSub.subscribe()
  end
end
