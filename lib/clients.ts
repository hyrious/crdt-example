import { val } from "./val.ts";

export const clients_ = new Set<number>();

export let notify_clients_change: () => void;

export const clients$ = val(clients_, set => {
  notify_clients_change = () => set(clients_);
});
