import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeleteServerDialog } from "./DeleteServerDialog";
import { api } from "../lib/api";
import { makeServer, renderWithProviders } from "../test/utils";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")),
  useNavigate: () => navigate,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

function open(server = makeServer()) {
  return renderWithProviders(
    <DeleteServerDialog server={server} open onOpenChange={() => {}} />,
  );
}

describe("DeleteServerDialog", () => {
  beforeEach(() => {
    navigate.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  it("offers only a plain removal when no provisioner is configured", async () => {
    vi.spyOn(api, "provisionDefaults").mockResolvedValue({ available: false });
    open(makeServer({ containerName: "palagent-palhalla" }));

    await screen.findByText(/only removes it from Palcon/i);
    // Give the defaults query a chance to resolve before asserting absence,
    // or this passes for the wrong reason.
    await waitFor(() => expect(api.provisionDefaults).toHaveBeenCalled());
    expect(screen.queryByLabelText(/destroy the container/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("hides the destroy option for a server with no container name", async () => {
    vi.spyOn(api, "provisionDefaults").mockResolvedValue({ available: true });
    open(makeServer({ containerName: "" }));

    await waitFor(() => expect(api.provisionDefaults).toHaveBeenCalled());
    expect(screen.queryByLabelText(/destroy the container/i)).not.toBeInTheDocument();
  });

  it("deletes the row only, when the option is left off", async () => {
    vi.spyOn(api, "provisionDefaults").mockResolvedValue({ available: true });
    const del = vi.spyOn(api, "deleteServer").mockResolvedValue(undefined);
    open(makeServer({ containerName: "palagent-palhalla" }));

    await screen.findByLabelText(/destroy the container/i);
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(del).toHaveBeenCalledWith(1, false));
    expect(toastSuccess).toHaveBeenCalledWith('Removed "Palhalla"', undefined);
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("names the container and renames the button once armed", async () => {
    vi.spyOn(api, "provisionDefaults").mockResolvedValue({ available: true });
    open(makeServer({ containerName: "palagent-palhalla" }));

    const toggle = await screen.findByLabelText(/destroy the container/i);
    expect(screen.getByText("palagent-palhalla")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();

    await userEvent.click(toggle);

    // The consequence is stated only once the switch is armed, and the
    // confirm button renames itself so the click names its own action.
    expect(screen.getByText(/World data stays on the host/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove and destroy" })).toBeInTheDocument();
  });

  it("destroys the container and reports where the world was kept", async () => {
    vi.spyOn(api, "provisionDefaults").mockResolvedValue({ available: true });
    const del = vi.spyOn(api, "deleteServer").mockResolvedValue({
      destroyed: "palagent-palhalla",
      dataDir: "/mnt/pool/apps/palworld-servers/palhalla",
    });
    open(makeServer({ containerName: "palagent-palhalla" }));

    await userEvent.click(await screen.findByLabelText(/destroy the container/i));
    await userEvent.click(screen.getByRole("button", { name: "Remove and destroy" }));

    await waitFor(() => expect(del).toHaveBeenCalledWith(1, true));
    expect(toastSuccess).toHaveBeenCalledWith(
      'Removed "Palhalla" and destroyed palagent-palhalla',
      { description: "World data kept at /mnt/pool/apps/palworld-servers/palhalla" },
    );
  });

  it("surfaces the server's own message when a destroy is refused", async () => {
    vi.spyOn(api, "provisionDefaults").mockResolvedValue({ available: true });
    vi.spyOn(api, "deleteServer").mockRejectedValue(
      new Error("that container was not created by this provisioner"),
    );
    open(makeServer({ containerName: "palagent-byhand" }));

    await userEvent.click(await screen.findByLabelText(/destroy the container/i));
    await userEvent.click(screen.getByRole("button", { name: "Remove and destroy" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "that container was not created by this provisioner",
      ),
    );
    // A refused destroy must not navigate away — the server is still there.
    expect(navigate).not.toHaveBeenCalled();
  });
});
