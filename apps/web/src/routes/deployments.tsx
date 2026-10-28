import { createFileRoute } from "@tanstack/react-router";
import { DeploymentsPage } from "../components/delivery/DeploymentsPage";

export const Route = createFileRoute("/deployments")({ component: DeploymentsPage });
