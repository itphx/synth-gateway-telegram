{{- define "synth-gateway-telegram.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "synth-gateway-telegram.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- .Values.nameOverride | default .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "synth-gateway-telegram.labels" -}}
helm.sh/chart: {{ include "synth-gateway-telegram.name" . }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "synth-gateway-telegram.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "synth-gateway-telegram.selectorLabels" -}}
app.kubernetes.io/name: {{ include "synth-gateway-telegram.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Имя hook-Job'а авто-установки (общий контракт шаблона add-on'ов). */}}
{{- define "synth-gateway-telegram.installJobName" -}}
{{- printf "%s-install" (include "synth-gateway-telegram.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Имя ConfigMap со скиллами (аддон без образа). */}}
{{- define "synth-gateway-telegram.skillsConfigMapName" -}}
{{- printf "%s-skills" (include "synth-gateway-telegram.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Образ hook-Job'а: autoInstall.image, иначе образ чарта.
*/}}
{{- define "synth-gateway-telegram.autoInstallImage" -}}
{{- if .Values.autoInstall.image -}}
{{- .Values.autoInstall.image -}}
{{- else if .Values.image.repository -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | toString) -}}
{{- else -}}
{{- required "autoInstall.image обязателен: у чарта не задан image.repository" "" -}}
{{- end -}}
{{- end }}

{{/*
Путь к инсталлятору внутри Job: из ConfigMap (scriptConfigMap) или из образа.
*/}}
{{- define "synth-gateway-telegram.installerPath" -}}
{{- if .Values.autoInstall.scriptConfigMap -}}
/opt/synth-addon/install-into-synth.mjs
{{- else -}}
{{- .Values.autoInstall.scriptPath | default "scripts/install-into-synth.mjs" -}}
{{- end -}}
{{- end }}

{{/* In-cluster адрес сервиса шлюза (для сборки URL MCP при авто-установке). */}}
{{- define "synth-gateway-telegram.serviceHost" -}}
{{- printf "%s.%s.svc.cluster.local" (include "synth-gateway-telegram.fullname" .) .Release.Namespace }}
{{- end }}

{{/*
Имя Secret с bearer-токеном MCP-клиентов (`GATEWAY_MCP_TOKEN`):
  1) mcp.tokenSecret.create=true → mcp.tokenSecret.name > mcp.tokenSecretName > <fullname>-mcp-token;
  2) иначе mcp.tokenSecretName > existingSecret (ключ ожидается внутри existingSecret).
Пусто — отдельного источника нет (контейнер MCP не стартует без токена — fail-fast).
*/}}
{{- define "synth-gateway-telegram.mcpTokenSecretName" -}}
{{- if .Values.mcp.tokenSecret.create -}}
{{- .Values.mcp.tokenSecret.name | default .Values.mcp.tokenSecretName | default (printf "%s-mcp-token" (include "synth-gateway-telegram.fullname" .)) -}}
{{- else -}}
{{- .Values.mcp.tokenSecretName | default .Values.existingSecret -}}
{{- end -}}
{{- end }}

{{/*
Ключ внутри Secret с токеном MCP: при tokenSecret.create — mcp.tokenSecret.key,
иначе mcp.tokenSecretKey. Оба по умолчанию GATEWAY_MCP_TOKEN.
*/}}
{{- define "synth-gateway-telegram.mcpTokenSecretKey" -}}
{{- if .Values.mcp.tokenSecret.create -}}
{{- .Values.mcp.tokenSecret.key | default "GATEWAY_MCP_TOKEN" -}}
{{- else -}}
{{- .Values.mcp.tokenSecretKey | default "GATEWAY_MCP_TOKEN" -}}
{{- end -}}
{{- end }}

{{/*
Задан ли у чарта явный источник токена MCP (создаваемый Secret или tokenSecretName).
Пусто — токен не пробрасывается адресно (возможен ключ в existingSecret через envFrom).
*/}}
{{- define "synth-gateway-telegram.hasExplicitMcpTokenSecret" -}}
{{- if or .Values.mcp.tokenSecret.create .Values.mcp.tokenSecretName -}}
true
{{- end -}}
{{- end }}
