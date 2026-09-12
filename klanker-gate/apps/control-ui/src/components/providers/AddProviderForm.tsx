import { type FormEvent, useState } from "react";
import { Plus } from "lucide-react";
import type { ProviderAccountConfig } from "../../api";
import { Field } from "../ui/label";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/select";
import { Button } from "../ui/button";
import { Banner } from "../ui/banner";
import { CLOUD_TYPES, PROVIDER_LABELS, PROVIDER_TYPES } from "./constants";

type ProviderType = ProviderAccountConfig["type"];

interface FormValues {
  id: string;
  type: ProviderType;
  apiKey: string;
  baseUrl: string;
  endpoint: string;
  apiVersion: string;
  modelName: string;
  deploymentName: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken: string;
  projectId: string;
  location: string;
  serviceAccountJson: string;
}

function empty(): FormValues {
  return {
    id: "",
    type: "openai",
    apiKey: "",
    baseUrl: "",
    endpoint: "",
    apiVersion: "",
    modelName: "",
    deploymentName: "",
    awsRegion: "",
    awsAccessKeyId: "",
    awsSecretAccessKey: "",
    awsSessionToken: "",
    projectId: "",
    location: "",
    serviceAccountJson: "",
  };
}

function assemble(v: FormValues): ProviderAccountConfig {
  const cloud = CLOUD_TYPES.has(v.type);
  const out: ProviderAccountConfig = {
    id: v.id.trim(),
    type: v.type,
    enabled: true,
    models: [],
    priority: 0,
  };
  if (!cloud && v.apiKey.trim() !== "") {
    out.apiKey = v.apiKey.trim();
  }
  if (v.baseUrl.trim() !== "") {
    out.baseUrl = v.baseUrl.trim();
  }
  if (v.type === "azure") {
    if (v.endpoint.trim()) out.endpoint = v.endpoint.trim();
    if (v.apiVersion.trim()) out.apiVersion = v.apiVersion.trim();
    // Azure routes on the deployment name (the URL segment the client calls as
    // `azure/<deployment>`); the model name is a catalog alias. Both feed the
    // advertised model list so the account is routable once created.
    out.models = [
      ...new Set([v.deploymentName.trim(), v.modelName.trim()]),
    ].filter((m) => m !== "");
  }
  if (v.type === "bedrock") {
    if (v.awsRegion.trim()) out.awsRegion = v.awsRegion.trim();
    if (v.awsAccessKeyId.trim()) out.awsAccessKeyId = v.awsAccessKeyId.trim();
    if (v.awsSecretAccessKey) out.awsSecretAccessKey = v.awsSecretAccessKey;
    if (v.awsSessionToken) out.awsSessionToken = v.awsSessionToken;
  }
  if (v.type === "vertex") {
    if (v.projectId.trim()) out.projectId = v.projectId.trim();
    if (v.location.trim()) out.location = v.location.trim();
    if (v.serviceAccountJson) out.serviceAccountJson = v.serviceAccountJson;
  }
  return out;
}

export interface AddProviderFormProps {
  busy: boolean;
  onSubmit: (payload: ProviderAccountConfig) => void;
  /** Prefill from a gallery preset (id/type/baseUrl). Remount (via `key`) to reset. */
  initial?: Partial<FormValues>;
}

/**
 * Inline add-provider form shown in the detail pane when no provider is
 * selected. Covers the common path (id, wire type, key, base URL) plus the
 * cloud/Azure credential fields, and posts a ProviderAccountConfig on submit.
 */
export function AddProviderForm(
  { busy, onSubmit, initial }: AddProviderFormProps,
) {
  const [v, setV] = useState<FormValues>(() => ({ ...empty(), ...initial }));
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setV((prev) => ({ ...prev, [key]: value }));

  const cloud = CLOUD_TYPES.has(v.type);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (v.id.trim() === "") {
      setError("Provider ID is required.");
      return;
    }
    if (v.type === "azure") {
      if (v.endpoint.trim() === "") {
        setError("An endpoint is required for Azure OpenAI.");
        return;
      }
      if (v.deploymentName.trim() === "") {
        setError("A deployment name is required for Azure OpenAI.");
        return;
      }
    }
    if (v.type === "vertex" && v.serviceAccountJson.trim() !== "") {
      try {
        JSON.parse(v.serviceAccountJson);
      } catch {
        setError("Service account JSON must be valid JSON.");
        return;
      }
    }
    setError(null);
    onSubmit(assemble(v));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div>
        <h3 className="text-lg font-semibold text-foreground">Add provider</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect an account the gateway can route inference to. Keys are stored
          server-side and never shown again.
        </p>
      </div>

      <div className="field-grid">
        <Field id="add-prov-id" label="ID" required>
          <Input
            id="add-prov-id"
            required
            placeholder="openai"
            value={v.id}
            onChange={(e) => set("id", e.target.value)}
          />
        </Field>
        <Field id="add-prov-type" label="Type">
          <NativeSelect
            id="add-prov-type"
            value={v.type}
            onChange={(e) => set("type", e.target.value as ProviderType)}
          >
            {PROVIDER_TYPES.map((t) => (
              <option key={t} value={t}>{PROVIDER_LABELS[t]}</option>
            ))}
          </NativeSelect>
        </Field>

        {!cloud && (
          <Field id="add-prov-key" label="API key">
            <Input
              id="add-prov-key"
              type="password"
              autoComplete="off"
              value={v.apiKey}
              onChange={(e) => set("apiKey", e.target.value)}
            />
          </Field>
        )}
        {v.type !== "azure" && (
          <Field id="add-prov-baseurl" label="Base URL">
            <Input
              id="add-prov-baseurl"
              placeholder="https://host"
              value={v.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
            />
          </Field>
        )}

        {v.type === "azure" && (
          <>
            <Field
              id="add-prov-endpoint"
              label="Endpoint"
              required
              hint="The Azure resource endpoint; it replaces the base URL for Azure."
            >
              <Input
                id="add-prov-endpoint"
                placeholder="https://my-resource.openai.azure.com"
                value={v.endpoint}
                onChange={(e) => set("endpoint", e.target.value)}
              />
            </Field>
            <Field id="add-prov-apiversion" label="API version">
              <Input
                id="add-prov-apiversion"
                placeholder="2024-06-01"
                value={v.apiVersion}
                onChange={(e) => set("apiVersion", e.target.value)}
              />
            </Field>
            <Field
              id="add-prov-deployment"
              label="Deployment name"
              required
              hint="Clients route to this as azure/<deployment>. Azure addresses it in the request URL."
            >
              <Input
                id="add-prov-deployment"
                placeholder="gpt-4o"
                value={v.deploymentName}
                onChange={(e) => set("deploymentName", e.target.value)}
              />
            </Field>
            <Field
              id="add-prov-modelname"
              label="Model name"
              hint="The underlying model, added as a catalog alias. Usually the same as the deployment name."
            >
              <Input
                id="add-prov-modelname"
                placeholder="gpt-4o"
                value={v.modelName}
                onChange={(e) => set("modelName", e.target.value)}
              />
            </Field>
          </>
        )}

        {v.type === "bedrock" && (
          <>
            <Field id="add-prov-awsregion" label="AWS region" required>
              <Input
                id="add-prov-awsregion"
                placeholder="us-east-1"
                value={v.awsRegion}
                onChange={(e) => set("awsRegion", e.target.value)}
              />
            </Field>
            <Field id="add-prov-awskey" label="AWS access key ID" required>
              <Input
                id="add-prov-awskey"
                value={v.awsAccessKeyId}
                onChange={(e) => set("awsAccessKeyId", e.target.value)}
              />
            </Field>
            <Field
              id="add-prov-awssecret"
              label="AWS secret access key"
              required
            >
              <Input
                id="add-prov-awssecret"
                type="password"
                autoComplete="off"
                value={v.awsSecretAccessKey}
                onChange={(e) => set("awsSecretAccessKey", e.target.value)}
              />
            </Field>
            <Field id="add-prov-awssession" label="AWS session token">
              <Input
                id="add-prov-awssession"
                type="password"
                autoComplete="off"
                value={v.awsSessionToken}
                onChange={(e) => set("awsSessionToken", e.target.value)}
              />
            </Field>
          </>
        )}

        {v.type === "vertex" && (
          <>
            <Field id="add-prov-project" label="Project ID" required>
              <Input
                id="add-prov-project"
                value={v.projectId}
                onChange={(e) => set("projectId", e.target.value)}
              />
            </Field>
            <Field id="add-prov-location" label="Location" required>
              <Input
                id="add-prov-location"
                placeholder="us-central1"
                value={v.location}
                onChange={(e) => set("location", e.target.value)}
              />
            </Field>
            <Field
              id="add-prov-sajson"
              label="Service account JSON"
              required
              className="field-wide"
            >
              <Textarea
                id="add-prov-sajson"
                rows={4}
                className="font-mono"
                value={v.serviceAccountJson}
                onChange={(e) => set("serviceAccountJson", e.target.value)}
              />
            </Field>
          </>
        )}
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="flex justify-end">
        <Button type="submit" isLoading={busy}>
          <Plus aria-hidden="true" />
          Add provider
        </Button>
      </div>
    </form>
  );
}
