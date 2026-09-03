#!/usr/bin/env python3
"""Small helpers for Wandao task reports.

Provider scripts can keep their platform-specific fields. ``finalize_report``
only fills the common fields that the desktop task center relies on.
"""

from __future__ import annotations

import os
import json
import re
from pathlib import Path
from typing import Any

from .errors import normalize_error


REPORT_SCHEMA_VERSION = 1
TASK_RESULT_KIND = "wandao.result"


def _number(*values: Any) -> int:
    for value in values:
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number > 0:
            return number
    return 0


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _non_negative_number(*values: Any) -> int:
    """Return the largest usable non-negative count in ``values``."""

    maximum = 0
    for value in values:
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number >= 0:
            maximum = max(maximum, number)
    return maximum


def _non_negative_value(value: Any) -> int | None:
    """Parse one explicit non-negative count, preserving an explicit zero."""

    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


_RESOURCE_TYPES = {"resource", "image", "attachment"}
_RESOURCE_REFERENCE_KEYS = (
    "url",
    "src",
    "ref",
    "source",
    "target",
    "file",
    "resource",
    "resourcePath",
    "localPath",
    "reference",
    "image",
    "attachment",
    "name",
)
_RESOURCE_DOCUMENT_KEYS = (
    "document",
    "relativePath",
    "path",
    "title",
    "docId",
    "nodeId",
    "itemKey",
)
_RESOURCE_ERROR_KEYS = ("error", "reason", "message", "status", "code", "warning")
_RESOURCE_CONTAINER_KEYS = ("failures", "warnings", "items", "resources", "entries")
_RESOURCE_WARNING_ROOTS = (
    ("resourceWarnings", "resource"),
    ("imageWarnings", "image"),
    ("attachmentWarnings", "attachment"),
    ("localImageReferenceFailures", "image"),
)


def _stringify_identity(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        try:
            return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError):
            return str(value)
    return str(value).strip()


def _first_value(item: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = _stringify_identity(item.get(key))
        if value:
            return value
    return ""


def _normalize_resource_kind(value: Any, fallback: str = "resource") -> str:
    text = _stringify_identity(value).lower()
    if re.search(r"image|img|图片", text):
        return "image"
    if re.search(r"attachment|附件|file", text):
        return "attachment"
    if re.search(r"resource|asset|资源", text):
        return "resource"
    # An empty fallback is meaningful to callers that are probing whether a
    # legacy failure is a resource.  Returning ``resource`` here would turn
    # every ordinary document failure into a resource warning.
    if fallback in _RESOURCE_TYPES or fallback == "":
        return fallback
    return "resource"


def _resource_kind_from_item(item: dict[str, Any], inherited: str = "resource") -> str:
    # A child item's explicit kind/type wins over the group-level kind.  This
    # matters for providers that put image and attachment failures under one
    # nested ``failures`` array.
    for key in ("kind", "type", "resourceType", "assetType", "category"):
        value = _normalize_resource_kind(item.get(key), "")
        if value in _RESOURCE_TYPES:
            return value
    return _normalize_resource_kind(inherited, "resource")


def _resource_type(item: dict[str, Any]) -> str:
    return _resource_kind_from_item(item, "resource")


def _resource_document_identity(item: dict[str, Any]) -> str:
    return _first_value(item, _RESOURCE_DOCUMENT_KEYS)


def _resource_reference_identity(item: dict[str, Any]) -> str:
    return _first_value(item, _RESOURCE_REFERENCE_KEYS)


def _resource_error_identity(item: dict[str, Any]) -> str:
    direct = _first_value(item, _RESOURCE_ERROR_KEYS)
    if direct:
        return direct
    error_info = item.get("errorInfo")
    if isinstance(error_info, dict):
        return _first_value(error_info, ("code", "technicalMessage", "message", "userMessage"))
    return ""


def _resource_identity_parts(item: dict[str, Any]) -> tuple[str, str, str]:
    return (
        _resource_document_identity(item),
        _resource_reference_identity(item),
        _resource_error_identity(item),
    )


def _resource_has_identity(item: dict[str, Any]) -> bool:
    return any(_resource_identity_parts(item))


def resource_failures(report: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten and de-duplicate resource failures from all provider shapes.

    Resource failures have appeared in three top-level arrays over time and
    some providers also repeat the same item in more than one array.  The
    identity deliberately excludes the resource type so a generic entry can
    be upgraded to a concrete image/attachment entry without double-counting.
    Image and attachment entries with the same identity remain separate.
    """

    items: list[dict[str, Any]] = []

    def add(value: dict[str, Any], inherited_kind: str, inherited_context: dict[str, Any]) -> None:
        context = dict(inherited_context)
        for key in _RESOURCE_DOCUMENT_KEYS:
            if key not in context and value.get(key) is not None:
                context[key] = value[key]
        kind = _resource_kind_from_item(value, inherited_kind)
        flattened = {**context, **value, "type": kind}
        _append_resource_failure(items, flattened)

    def visit(
        value: Any,
        inherited_kind: str = "resource",
        inherited_context: dict[str, Any] | None = None,
        *,
        scalar_item: bool = False,
    ) -> None:
        if inherited_context is None:
            inherited_context = {}
        if isinstance(value, list):
            for child in value:
                # A number/string inside a warning list is one warning item;
                # a number used directly as ``imageWarnings`` is a count and
                # must not turn into a synthetic detail row.
                visit(child, inherited_kind, inherited_context, scalar_item=True)
            return
        if value is None or isinstance(value, (str, int, float, bool)):
            if scalar_item and _stringify_identity(value):
                text = _stringify_identity(value)
                add({"warning": value, "message": text}, inherited_kind, inherited_context)
            return
        if not isinstance(value, dict):
            return

        kind = _resource_kind_from_item(value, inherited_kind)
        context = dict(inherited_context)
        for key in _RESOURCE_DOCUMENT_KEYS:
            if key not in context and value.get(key) is not None:
                context[key] = value[key]
        has_children = False
        for container_key in _RESOURCE_CONTAINER_KEYS:
            children = value.get(container_key)
            if not isinstance(children, (list, dict)):
                continue
            has_children = True
            visit(children, kind, context, scalar_item=True)
        if has_children:
            return

        if any(value.get(key) not in (None, "") for key in (*_RESOURCE_REFERENCE_KEYS, *_RESOURCE_ERROR_KEYS, "errorInfo")):
            add(value, kind, context)

    for key, resource_type in (("resourceFailures", "resource"), ("imageFailures", "image"), ("attachmentFailures", "attachment")):
        visit(report.get(key), resource_type)

    # Importers use warning fields for resources that were intentionally
    # skipped (for example a missing local image). They can live at the report
    # root or inside a per-document result, so walk both shapes while
    # preserving the document context.
    for key, resource_type in _RESOURCE_WARNING_ROOTS:
        for _, value, context in _iter_named_values(report, {key}):
            visit(value, resource_type, context)

    # A few legacy providers copied resource entries into the document
    # failure list.  Promote them only when their shape is unambiguous or they
    # match an explicit resource entry; ``_append_resource_failure`` then
    # merges the duplicate rather than displaying it twice.
    known_resources = list(items)
    for item in _list(report.get("failures")):
        if not isinstance(item, dict):
            continue
        kind = _resource_kind_for_failure(item, known_resources)
        if kind:
            visit({**item, "type": kind}, kind)
    return items


def _resource_fingerprint(item: dict[str, Any]) -> str:
    return "\x00".join((_resource_type(item), *_resource_identity_parts(item)))


def _resource_fingerprint_without_type(item: dict[str, Any]) -> str:
    return "\x00".join(_resource_identity_parts(item))


def _resource_reference_fingerprint(item: dict[str, Any]) -> str:
    return "\x00".join((_resource_reference_identity(item), _resource_error_identity(item)))


def _local_image_reference_alias(item: dict[str, Any]) -> str:
    """Return a local-image reference embedded in a legacy reason string."""

    direct = _first_value(item, ("reference",))
    if direct:
        return direct
    for key in ("reason", "error", "message"):
        text = _stringify_identity(item.get(key))
        if not text.startswith("本地图片引用未修复"):
            continue
        remainder = re.sub(r"^本地图片引用未修复\s*[:：]\s*", "", text)
        for separator in ("（", "("):
            if separator in remainder:
                return remainder.split(separator, 1)[0].strip()
        if remainder:
            return remainder.strip()
    return ""


def _resource_types_compatible(left: str, right: str) -> bool:
    return left == right or left == "resource" or right == "resource"


def _resource_items_match(left: dict[str, Any], right: dict[str, Any]) -> bool:
    """Match duplicate resource entries while retaining image/attachment separation."""

    left_type = _resource_type(left)
    right_type = _resource_type(right)
    if not _resource_types_compatible(left_type, right_type):
        return False
    left_identity = _resource_fingerprint_without_type(left)
    right_identity = _resource_fingerprint_without_type(right)
    if left_identity == right_identity and (
        _resource_has_identity(left)
        or _resource_has_identity(right)
        or _resource_fingerprint(left) == _resource_fingerprint(right)
    ):
        return True

    # ima historically reported the same local-image problem twice: once as
    # ``localImageReferenceFailures`` and once in ``resourceFailures`` with
    # the reference embedded in the reason text.
    left_reference = _local_image_reference_alias(left)
    right_reference = _local_image_reference_alias(right)
    if not left_reference or not right_reference or left_reference != right_reference:
        return False
    left_document = _resource_document_identity(left)
    right_document = _resource_document_identity(right)
    return not left_document or not right_document or left_document == right_document


def _merge_resource_items(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    left_type = _resource_type(left)
    right_type = _resource_type(right)
    preferred_type = right_type if left_type == "resource" and right_type != "resource" else left_type
    merged = dict(left)
    for key, value in right.items():
        if key not in merged or merged[key] in (None, "", [], {}):
            merged[key] = value
    # Keep the provider's concrete classification when one side has it, while
    # retaining all other provider-specific fields from both sides.
    merged["type"] = preferred_type
    if preferred_type != "resource" and (not merged.get("kind") or _normalize_resource_kind(merged.get("kind"), "") == "resource"):
        merged["kind"] = preferred_type
    return merged


def _append_resource_failure(items: list[dict[str, Any]], candidate: dict[str, Any]) -> None:
    candidate_type = _resource_type(candidate)
    matches = [
        index
        for index, existing in enumerate(items)
        if _resource_items_match(existing, candidate)
    ]
    if not matches:
        items.append(candidate)
        return

    # A generic resource can describe either an image or an attachment.  It is
    # therefore merged into one compatible concrete item, never into both;
    # otherwise a provider that reports the same generic warning alongside
    # imageFailures and attachmentFailures would lose one of the two entries.
    same_type = [index for index in matches if _resource_type(items[index]) == candidate_type]
    generic = [index for index in matches if _resource_type(items[index]) == "resource"]
    concrete = [index for index in matches if _resource_type(items[index]) != "resource"]
    if candidate_type == "resource":
        preferred = concrete[0] if concrete else (generic[0] if generic else matches[0])
        removable_types = {_resource_type(items[preferred])}
        removable = [
            index
            for index in matches
            if index != preferred and _resource_type(items[index]) in removable_types
        ]
    elif same_type:
        preferred = same_type[0]
        # A concrete entry upgrades matching generic entries, while another
        # concrete kind (image vs attachment) remains an independent failure.
        removable = [index for index in matches if index != preferred and _resource_type(items[index]) in {"resource", candidate_type}]
    elif generic:
        preferred = generic[0]
        removable = [index for index in matches if index != preferred and _resource_type(items[index]) == "resource"]
    else:
        # This branch is defensive; incompatible concrete kinds are filtered
        # above and should not be in ``matches``.
        preferred = matches[0]
        removable = []

    merged = _merge_resource_items(items[preferred], candidate)
    for index in sorted(removable, reverse=True):
        merged = _merge_resource_items(merged, items[index])
        items.pop(index)
    # Removing an earlier matching entry shifts the preferred index left.
    shifted_preferred = preferred - sum(1 for index in removable if index < preferred)
    items[shifted_preferred] = merged


def _resource_kind_for_failure(item: Any, known_resources: list[dict[str, Any]]) -> str:
    if not isinstance(item, dict):
        return ""
    explicit = _resource_kind_from_item(item, "")
    if explicit in _RESOURCE_TYPES and any(item.get(key) not in (None, "") for key in ("kind", "type", "resourceType", "assetType")):
        return explicit

    without_type = _resource_fingerprint_without_type(item)
    reference = _resource_reference_fingerprint(item)
    for resource in known_resources:
        if (without_type and without_type == _resource_fingerprint_without_type(resource)) or (
            reference and reference == _resource_reference_fingerprint(resource)
        ):
            return _resource_type(resource)

    kind_text = " ".join(_stringify_identity(item.get(key)) for key in ("category", "assetType", "resourceType")).lower()
    error_info = item.get("errorInfo") if isinstance(item.get("errorInfo"), dict) else {}
    error_text = " ".join(
        _stringify_identity(item.get(key)) for key in (*_RESOURCE_ERROR_KEYS, "errorInfo")
    ).lower()
    error_text += " " + " ".join(_stringify_identity(error_info.get(key)) for key in ("code", "category", "message", "technicalMessage"))
    has_reference = any(item.get(key) not in (None, "") for key in _RESOURCE_REFERENCE_KEYS)
    has_document_identity = any(item.get(key) not in (None, "") for key in _RESOURCE_DOCUMENT_KEYS)
    has_explicit_marker = any(
        item.get(key) not in (None, "")
        for key in ("kind", "type", "resourceType", "assetType", "category")
    )
    # A normal document failure can also contain ``path``/``url`` and mention
    # an image in its message.  Do not reinterpret it as a resource unless it
    # has no document identity or carries an explicit resource marker.
    can_infer_from_text = not has_document_identity or has_explicit_marker
    if has_reference and can_infer_from_text and re.search(r"image|img|图片", kind_text + " " + error_text):
        return "image"
    if has_reference and can_infer_from_text and re.search(r"attachment|附件|resource|asset|资源|上传附件", kind_text + " " + error_text):
        return "attachment" if re.search(r"attachment|附件", kind_text + " " + error_text) else "resource"
    return ""


def _iter_named_values(
    value: Any,
    names: set[str],
    inherited_context: dict[str, Any] | None = None,
    seen: set[int] | None = None,
):
    """Yield warning fields found at the top level or inside document metadata."""

    context = dict(inherited_context or {})
    seen = seen if seen is not None else set()
    if isinstance(value, list):
        identity = id(value)
        if identity in seen:
            return
        seen.add(identity)
        for child in value:
            yield from _iter_named_values(child, names, context, seen)
        return
    if not isinstance(value, dict):
        return
    identity = id(value)
    if identity in seen:
        return
    seen.add(identity)
    for key in _RESOURCE_DOCUMENT_KEYS:
        if key not in context and value.get(key) is not None:
            context[key] = value[key]
    for key, child in value.items():
        if key in names:
            yield key, child, context
        if isinstance(child, (dict, list)):
            yield from _iter_named_values(child, names, context, seen)


def _looks_like_resource_failure(item: Any, known_resources: list[dict[str, Any]]) -> bool:
    """Recognize legacy resource entries that were placed in ``failures``.

    Newer providers use ``imageFailures``/``attachmentFailures`` explicitly,
    but a few older providers also copied the same ``{url, error}`` item into
    the top-level failure list.  Do not let that duplicate turn into a failed
    document while keeping ordinary document failures (which may contain a
    URL) intact.
    """

    return bool(_resource_kind_for_failure(item, known_resources))


def document_failures(report: dict[str, Any]) -> list[Any]:
    known_resources = resource_failures(report)
    return [item for item in _list(report.get("failures")) if not _looks_like_resource_failure(item, known_resources)]


def _failure_count(report: dict[str, Any]) -> int:
    documents = document_failures(report)
    explicit_document_count = _non_negative_value(report.get("documentFailureCount"))
    if explicit_document_count is not None:
        return max(explicit_document_count, len(documents))

    legacy_count = _non_negative_number(
        report.get("failureCount"),
        report.get("failedDocs"),
        report.get("failed"),
        report.get("errorCount"),
    )
    raw_failures = _list(report.get("failures"))
    primary_legacy_count = _non_negative_value(report.get("failureCount"))
    if primary_legacy_count is not None and primary_legacy_count == len(raw_failures) and raw_failures:
        resources_in_legacy_list = sum(
            1 for item in raw_failures if _looks_like_resource_failure(item, resource_failures(report))
        )
        if resources_in_legacy_list:
            legacy_count = max(0, primary_legacy_count - resources_in_legacy_list)
    return max(legacy_count, len(documents))


def _resource_failure_count(report: dict[str, Any]) -> int:
    return _resource_counts(report)[2]


def _warning_count(report: dict[str, Any], name: str) -> int:
    """Count warning entries when a provider returns a list, object or count.

    A warning field may be an aggregate integer, a list of resource objects,
    or a document wrapper containing ``failures``/``items``.  Counts are
    summed across separate document contexts, while a later type-level
    reconciliation chooses the largest trustworthy representation so an
    alias list does not get counted twice.
    """

    def count_value(value: Any, *, list_item: bool = False) -> int:
        if isinstance(value, list):
            return sum(count_value(child, list_item=True) for child in value)
        if isinstance(value, dict):
            nested_counts: list[int] = []
            for container_key in _RESOURCE_CONTAINER_KEYS:
                child = value.get(container_key)
                if isinstance(child, (list, dict)):
                    nested_counts.append(count_value(child, list_item=True))
            explicit_counts: list[int] = []
            for count_key in ("count", "total", "size"):
                parsed = _non_negative_value(value.get(count_key))
                if parsed is not None:
                    explicit_counts.append(parsed)
            if nested_counts or explicit_counts:
                # Providers sometimes put both an aggregate count and a
                # shorter alias list in the same wrapper.  They are
                # alternative evidence, not additive buckets.
                return max((*nested_counts, *explicit_counts))
            return 1 if _resource_has_identity(value) else 0
        if value is None or value is False:
            return 0
        if list_item:
            # Numeric values in a warning list represent entries, whereas a
            # numeric warning field itself represents an aggregate count.
            return 1 if _stringify_identity(value) else 0
        parsed = _non_negative_value(value)
        if parsed is not None:
            return parsed
        return 1 if _stringify_identity(value) else 0

    return sum(count_value(value) for _, value, _ in _iter_named_values(report, {name}))


def _resource_counts(
    report: dict[str, Any],
    resources: list[dict[str, Any]] | None = None,
) -> tuple[int, int, int]:
    """Return ``(image, attachment, total)`` using one stable precedence rule.

    Listed resource items are de-duplicated first.  Explicit type counts and
    warning counts are treated as alternative evidence for that type, so the
    maximum is used instead of adding aliases.  The generic resource count is
    also an aggregate/unknown count and is therefore reconciled with the
    typed total using ``max`` rather than added to it.
    """

    listed = resources if resources is not None else resource_failures(report)
    listed_image = sum(1 for item in listed if _resource_type(item) == "image")
    listed_attachment = sum(1 for item in listed if _resource_type(item) == "attachment")
    image_count = max(
        listed_image,
        _non_negative_number(report.get("imageFailureCount")),
        _warning_count(report, "imageWarnings"),
        _warning_count(report, "localImageReferenceFailures"),
    )
    attachment_count = max(
        listed_attachment,
        _non_negative_number(report.get("attachmentFailureCount")),
        _warning_count(report, "attachmentWarnings"),
    )
    total_count = max(
        len(listed),
        _non_negative_number(report.get("resourceFailureCount")),
        _warning_count(report, "resourceWarnings"),
        image_count + attachment_count,
    )
    return image_count, attachment_count, total_count


def _normalize_failure_item(
    item: Any,
    *,
    provider: str = "",
    operation: str = "",
    resource_type: str = "",
) -> Any:
    """Add an error envelope to a failure item without changing its shape."""

    if not isinstance(item, dict):
        return item
    normalized = dict(item)
    raw_error = normalized.get("errorInfo") or (
        normalized.get("error")
        or normalized.get("reason")
        or normalized.get("message")
    )
    if raw_error:
        normalized["errorInfo"] = normalize_error(
            raw_error,
            provider=provider,
            operation=operation or resource_type,
        )
        # Keep legacy fields for older consumers, but make sure a copied
        # report cannot leak a cookie/token that arrived in an old string.
        for key in ("error", "reason", "message", "errorMessage"):
            if isinstance(normalized.get(key), str):
                normalized[key] = normalize_error(normalized[key])["technicalMessage"]
    if resource_type and not normalized.get("type") and not normalized.get("kind"):
        normalized["type"] = resource_type
    return normalized


def derive_outcome(report: dict[str, Any]) -> str:
    """Return the user-visible terminal outcome for a finalized task report.

    A successful process exit is not sufficient evidence of a successful task:
    document or required-resource failures make the outcome partial.  Process
    crashes are represented by the process result layer and therefore do not
    need to be inferred here.
    """

    if report.get("stopped"):
        return "stopped"
    if report.get("rateLimitedPaused"):
        return "paused"
    if _failure_count(report) or _resource_failure_count(report):
        return "partial"
    return "completed"


def success_count(report: dict[str, Any]) -> int:
    return _number(
        report.get("successCount"),
        report.get("exportedDocs"),
        report.get("importedDocs"),
        report.get("importedCount"),
        report.get("importedFiles"),
        report.get("exported"),
        report.get("imported"),
        _number(report.get("createdDocs")) + _number(report.get("updatedDocs")),
    )


def finalize_report(
    report: dict[str, Any],
    *,
    provider: str = "",
    mode: str = "",
    report_file: str | Path | None = None,
    output: str | Path | None = None,
) -> dict[str, Any]:
    finalized = dict(report or {})
    finalized["kind"] = TASK_RESULT_KIND
    finalized["schemaVersion"] = REPORT_SCHEMA_VERSION
    finalized.setdefault("runId", os.environ.get("WANDAO_RUN_ID") or os.environ.get("WANDAO_TASK_ID", ""))
    finalized.setdefault("jobId", os.environ.get("WANDAO_JOB_ID", ""))
    finalized.setdefault("parentRunId", os.environ.get("WANDAO_PARENT_RUN_ID", ""))
    if "reportSchemaVersion" not in finalized:
        finalized["reportSchemaVersion"] = REPORT_SCHEMA_VERSION
    if provider and not finalized.get("provider"):
        finalized["provider"] = provider
    if not finalized.get("provider") and finalized.get("platform"):
        finalized["provider"] = finalized["platform"]
    if mode and not finalized.get("mode"):
        finalized["mode"] = mode
    if report_file and not finalized.get("reportFile"):
        finalized["reportFile"] = str(report_file)
    if output and not finalized.get("output"):
        finalized["output"] = str(output)
    if finalized.get("errorInfo") or finalized.get("error") or finalized.get("errorMessage"):
        finalized["errorInfo"] = normalize_error(
            finalized.get("errorInfo") or finalized.get("error") or finalized.get("errorMessage"),
            provider=str(finalized.get("provider") or provider or ""),
            operation=str(finalized.get("mode") or mode or ""),
        )
        # Retain the legacy field, but never carry an unredacted provider
        # message into a report that can be copied or persisted by the UI.
        if isinstance(finalized.get("error"), str):
            finalized["error"] = normalize_error(finalized["error"])["technicalMessage"]
        else:
            finalized["error"] = finalized["errorInfo"].get("technicalMessage") or finalized["errorInfo"].get("userMessage", "")
        if isinstance(finalized.get("errorMessage"), str):
            finalized["errorMessage"] = normalize_error(finalized["errorMessage"])["technicalMessage"]
    finalized.setdefault(
        "totalDocs",
        _number(
            finalized.get("totalDocs"),
            finalized.get("total"),
            finalized.get("docCount"),
            finalized.get("fileCount"),
            finalized.get("selectedDocs"),
            finalized.get("sourceDocCount"),
            finalized.get("selectedFiles"),
            finalized.get("sourceFileCount"),
        ),
    )
    finalized["failures"] = [
        _normalize_failure_item(
            item,
            provider=str(finalized.get("provider") or provider or ""),
            operation=str(finalized.get("mode") or mode or ""),
        )
        for item in _list(finalized.get("failures"))
    ]
    normalized_resources = resource_failures(finalized)
    normalized_resources = [
        _normalize_failure_item(
            item,
            provider=str(finalized.get("provider") or provider or ""),
            operation=str(finalized.get("mode") or mode or ""),
            resource_type=str(item.get("type") or item.get("kind") or "resource"),
        )
        for item in normalized_resources
    ]
    finalized["resourceFailures"] = normalized_resources
    image_count, attachment_count, combined_resource_count = _resource_counts(
        finalized,
        normalized_resources,
    )
    if normalized_resources or any(
        key in finalized
        for key in (
            "resourceFailureCount",
            "imageFailureCount",
            "attachmentFailureCount",
            "resourceWarnings",
            "imageWarnings",
            "attachmentWarnings",
            "localImageReferenceFailures",
        )
    ):
        finalized["resourceFailureCount"] = combined_resource_count
        finalized["imageFailureCount"] = image_count
        finalized["attachmentFailureCount"] = attachment_count
    finalized.setdefault("successCount", success_count(finalized))
    finalized["documentFailureCount"] = _failure_count(finalized)
    finalized["failureCount"] = finalized["documentFailureCount"]
    finalized["outcome"] = derive_outcome(finalized)
    return finalized
