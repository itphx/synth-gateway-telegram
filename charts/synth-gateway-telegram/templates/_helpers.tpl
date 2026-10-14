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
