"""Tests for MCP server tool registration and basic invocation."""

import json

import pytest

from scoring import rank_photos


class TestRankBestShotsLogic:
    """Test the core ranking logic used by the rank_best_shots tool."""

    def test_rank_returns_sorted(self):
        scores = [
            {
                "photo_id": "low",
                "quality_score": 10.0,
                "family_score": 10.0,
                "event_score": 10.0,
                "uniqueness_score": 10.0,
                "scene_description": "",
                "event_type": "daily",
                "faces_detected": 0,
                "known_persons": [],
            },
            {
                "photo_id": "high",
                "quality_score": 90.0,
                "family_score": 90.0,
                "event_score": 90.0,
                "uniqueness_score": 90.0,
                "scene_description": "",
                "event_type": "birthday",
                "faces_detected": 3,
                "known_persons": ["Alice"],
            },
        ]
        ranked = rank_photos(scores, top_n=2)
        assert ranked[0].photo_id == "high"
        assert ranked[1].photo_id == "low"

    def test_rank_json_roundtrip(self):
        scores = [
            {
                "photo_id": "p1",
                "quality_score": 75.0,
                "family_score": 60.0,
                "event_score": 80.0,
                "uniqueness_score": 100.0,
                "scene_description": "family at park",
                "event_type": "outdoor",
                "faces_detected": 3,
                "known_persons": ["Alice", "Bob"],
            }
        ]
        ranked = rank_photos(scores)
        result_json = json.dumps([r.to_dict() for r in ranked])
        parsed = json.loads(result_json)
        assert len(parsed) == 1
        assert parsed[0]["photo_id"] == "p1"
        assert "total_score" in parsed[0]


class TestToolRegistration:
    """Verify FastMCP server has expected tools (import-only check)."""

    def test_import_server(self):
        # Ensure server module loads without errors
        import server

        assert hasattr(server, "mcp")

    def test_mcp_has_tools(self):
        import server

        # FastMCP registers tools via decorators
        # Just verify the module has tool functions
        assert callable(getattr(server, "score_quality", None))
        assert callable(getattr(server, "detect_faces", None))
        assert callable(getattr(server, "describe_scene", None))
        assert callable(getattr(server, "classify_event", None))
        assert callable(getattr(server, "find_duplicates", None))
        assert callable(getattr(server, "rank_best_shots", None))

    def test_mcp_has_album_tools(self):
        import server

        assert callable(getattr(server, "create_album", None))
        assert callable(getattr(server, "add_to_album", None))
        assert callable(getattr(server, "organize_results", None))
        assert callable(getattr(server, "import_photos", None))
        assert callable(getattr(server, "import_and_organize", None))
        assert callable(getattr(server, "list_photo_albums", None))

    def test_mcp_has_workflow_tool(self):
        import server

        assert callable(getattr(server, "classify_and_organize", None))

    def test_mcp_has_known_face_tools(self):
        import server

        assert callable(getattr(server, "register_face", None))
        assert callable(getattr(server, "list_known_faces", None))
        assert callable(getattr(server, "register_face_from_job", None))
        assert callable(getattr(server, "delete_known_face", None))


class TestRegisterFaceFromJob:
    """Test register_face_from_job MCP tool logic."""

    @pytest.mark.asyncio
    async def test_register_from_cached_embedding(self):
        """Should register a face from cached embeddings in DB."""
        import server
        from unittest.mock import MagicMock, patch

        mock_db = MagicMock()
        mock_db.load_face_embeddings.return_value = [
            {"face_idx": 0, "embedding": [0.1] * 512, "gender": "male", "age": 30, "expression": "unknown"},
            {"face_idx": 1, "embedding": [0.2] * 512, "gender": "female", "age": 28, "expression": "happy"},
        ]
        mock_db.save_known_face.return_value = 0

        with patch.object(server, "_get_job_db", return_value=mock_db):
            result = await server.register_face_from_job("photo_1", 1, "Alice")

        parsed = json.loads(result)
        assert parsed["name"] == "Alice"
        assert parsed["embedding_dim"] == 512
        assert parsed["source_photo"] == "photo_1"
        assert parsed["source_face_idx"] == 1

    @pytest.mark.asyncio
    async def test_register_from_missing_photo(self):
        """Should return error for missing photo embeddings."""
        import server
        from unittest.mock import MagicMock, patch

        mock_db = MagicMock()
        mock_db.load_face_embeddings.return_value = []

        with patch.object(server, "_get_job_db", return_value=mock_db):
            result = await server.register_face_from_job("missing_photo", 0, "Alice")

        parsed = json.loads(result)
        assert "error" in parsed

    @pytest.mark.asyncio
    async def test_register_from_wrong_index(self):
        """Should return error for invalid face_idx."""
        import server
        from unittest.mock import MagicMock, patch

        mock_db = MagicMock()
        mock_db.load_face_embeddings.return_value = [
            {"face_idx": 0, "embedding": [0.1] * 128, "gender": "", "age": 0, "expression": "unknown"},
        ]

        with patch.object(server, "_get_job_db", return_value=mock_db):
            result = await server.register_face_from_job("photo_1", 5, "Alice")

        parsed = json.loads(result)
        assert "error" in parsed
        assert 0 in parsed["available_indices"]


class TestDeleteKnownFace:
    """Test delete_known_face MCP tool logic."""

    @pytest.mark.asyncio
    async def test_delete_known_face(self):
        import server
        from unittest.mock import MagicMock, patch

        mock_db = MagicMock()
        mock_db.delete_known_face.return_value = 3

        with patch.object(server, "_get_job_db", return_value=mock_db):
            result = await server.delete_known_face("Alice")

        parsed = json.loads(result)
        assert parsed["name"] == "Alice"
        assert parsed["deleted_embeddings"] == 3
