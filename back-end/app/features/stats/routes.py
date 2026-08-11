"""
Stats feature - API routes for quiz attempt tracking & analytics.

Endpoints:
  POST   /api/stats/attempts              - Save a quiz attempt
  GET    /api/stats/folder/<folder_id>    - Folder detail stats
"""
import uuid
import logging
from datetime import datetime, timezone, timedelta
from collections import defaultdict

from flask import Blueprint, request, jsonify
from sqlalchemy import func

from app.db import db
from app.features.stats.models import QuizAttempt
from app.features.quizz.models import QuizSet
from app.features.folder.models import Folder
from app.utils.times import iso_utc

logger = logging.getLogger(__name__)

stats_bp = Blueprint("stats", __name__)


# ── Save attempt ───────────────────────────────────────────────────────────────

@stats_bp.route("/attempts", methods=["POST"])
def save_attempt():
    """Save a quiz attempt result."""
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    quiz_set_id = data.get("quizSetId")
    if not quiz_set_id:
        return jsonify({"error": "quizSetId is required"}), 400

    # The attempt is meaningless without its quiz set: it would not show up in any
    # stats screen (those filter by folder), and with foreign keys now enforced the
    # insert fails anyway. Say so plainly instead of returning 201 for a row that
    # is dropped or invisible.
    quiz_set = QuizSet.query.get(quiz_set_id)
    if quiz_set is None:
        return jsonify({"error": f"Quiz set not found: {quiz_set_id}"}), 404
    folder_id = quiz_set.folder_id

    attempt = QuizAttempt(
        id=str(uuid.uuid4()),
        quiz_set_id=quiz_set_id,
        folder_id=folder_id,
        score=data.get("score", 0),
        correct_count=data.get("correctCount", 0),
        wrong_count=data.get("wrongCount", 0),
        skipped_count=data.get("skippedCount", 0),
        total_questions=data.get("totalQuestions", 0),
        time_taken=data.get("timeTaken", 0),
    )
    attempt.set_answers_detail(data.get("questionResults", []))

    db.session.add(attempt)
    db.session.commit()

    logger.info("Saved attempt %s for quiz %s (score=%.1f%%)", attempt.id, quiz_set_id, attempt.score)
    return jsonify(attempt.to_dict()), 201







# ── Folder detail stats ───────────────────────────────────────────────────────

@stats_bp.route("/folder/<folder_id>", methods=["GET"])
def folder_detail_stats(folder_id):
    """
    Return detailed stats for a specific folder: overall summary, per-quiz-set
    breakdown, score distribution, and recent progress.

    Response: {
      summary: { avgScore, bestScore, worstScore, totalAttempts, totalCorrect,
                 totalQuestions, accuracy, avgTimeTaken, improvementRate },
      quizBreakdown: [{ quizSetId, title, questionCount, attempts: [{...}],
                        bestScore, avgScore, lastScore }],
      scoreDistribution: { excellent, good, average, poor },
      recentAttempts: [{ id, quizSetId, quizTitle, score, ... }],
      weakQuestions: [{ questionText, correctRate, attemptCount }],
    }
    """
    folder = Folder.query.get(folder_id)
    if not folder:
        return jsonify({"error": "Folder not found"}), 404

    # ── All quiz sets in this folder ──
    quiz_sets = QuizSet.query.filter_by(folder_id=folder_id).order_by(QuizSet.created_at.desc()).all()
    total_quiz_sets = len(quiz_sets)

    # ── All attempts in this folder ──
    all_attempts = (
        QuizAttempt.query
        .filter_by(folder_id=folder_id)
        .order_by(QuizAttempt.created_at.asc())
        .all()
    )

    # Build quiz map
    quiz_map = {qs.id: qs for qs in quiz_sets}
    attempts_by_quiz = defaultdict(list)
    for a in all_attempts:
        attempts_by_quiz[a.quiz_set_id].append(a)

    # ── Quiz breakdown (always returned, even with 0 attempts) ──
    quiz_breakdown = []
    attempted_set_ids = set()
    for qs in quiz_sets:
        qs_attempts = attempts_by_quiz.get(qs.id, [])
        if not qs_attempts:
            quiz_breakdown.append({
                "quizSetId": qs.id,
                "title": qs.title or "Untitled",
                "questionCount": len(qs.questions),
                "attemptCount": 0,
                "bestScore": None,
                "avgScore": None,
                "lastScore": None,
                "lastAttemptAt": None,
            })
            continue

        attempted_set_ids.add(qs.id)
        qs_scores = [a.score for a in qs_attempts]
        last_attempt = max(qs_attempts, key=lambda a: a.created_at)
        quiz_breakdown.append({
            "quizSetId": qs.id,
            "title": qs.title or "Untitled",
            "questionCount": len(qs.questions),
            "attemptCount": len(qs_attempts),
            "bestScore": round(max(qs_scores), 1),
            "avgScore": round(sum(qs_scores) / len(qs_scores), 1),
            "lastScore": round(last_attempt.score, 1),
            "lastAttemptAt": iso_utc(last_attempt.created_at),
        })

    completed_quiz_sets = len(attempted_set_ids)

    if not all_attempts:
        return jsonify({
            "summary": {
                "avgScore": 0, "bestScore": 0, "worstScore": 0,
                "totalAttempts": 0, "totalCorrect": 0, "totalQuestions": 0,
                "accuracy": 0, "avgTimeTaken": 0, "improvementRate": 0,
            },
            "progress": {
                "completedQuizSets": 0,
                "totalQuizSets": total_quiz_sets,
                "completionRate": 0,
            },
            "gamification": {
                "level": 1,
                "currentXP": 0,
                "xpToNextLevel": 100,
                "totalXP": 0,
                "streakDays": 0,
                "dailyGoal": 3,
                "dailyCompleted": 0,
                "badges": [],
            },
            "categoryAnalysis": {
                "byDifficulty": {},
                "byQuestionType": {},
            },
            "quizBreakdown": quiz_breakdown,
            "recentAttempts": [],
        })

    # ── Summary aggregates ──
    scores = [a.score for a in all_attempts]
    total_correct = sum(a.correct_count for a in all_attempts)
    total_questions = sum(a.total_questions for a in all_attempts)
    times = [a.time_taken for a in all_attempts if a.time_taken > 0]

    half = len(scores) // 2
    if half > 0:
        first_half_avg = sum(scores[:half]) / half
        second_half_avg = sum(scores[half:]) / (len(scores) - half)
        improvement_rate = round(second_half_avg - first_half_avg, 1)
    else:
        improvement_rate = 0

    summary = {
        "avgScore": round(sum(scores) / len(scores), 1),
        "bestScore": round(max(scores), 1),
        "worstScore": round(min(scores), 1),
        "totalAttempts": len(all_attempts),
        "totalCorrect": total_correct,
        "totalQuestions": total_questions,
        "accuracy": round(total_correct / total_questions * 100, 1) if total_questions > 0 else 0,
        "avgTimeTaken": round(sum(times) / len(times)) if times else 0,
        "improvementRate": improvement_rate,
    }

    # ── Progress ──
    completion_rate = round(completed_quiz_sets / total_quiz_sets * 100) if total_quiz_sets > 0 else 0
    progress = {
        "completedQuizSets": completed_quiz_sets,
        "totalQuizSets": total_quiz_sets,
        "completionRate": completion_rate,
    }

    # ── Gamification ──
    # XP: 10 per attempt + bonus for high scores
    total_xp = 0
    for a in all_attempts:
        xp = 10  # base
        if a.score >= 80:
            xp += 15
        elif a.score >= 60:
            xp += 8
        elif a.score >= 40:
            xp += 3
        total_xp += xp

    # Level: every 100 XP = 1 level, exponential scaling
    level = 1
    xp_remaining = total_xp
    xp_for_level = 100
    while xp_remaining >= xp_for_level:
        xp_remaining -= xp_for_level
        level += 1
        xp_for_level = int(100 * (1.2 ** (level - 1)))  # exponential

    # Streak
    streak = 0
    today = datetime.now(timezone.utc).date()
    day = today
    while True:
        day_start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
        day_end = day_start + timedelta(days=1)
        has_attempt = QuizAttempt.query.filter(
            QuizAttempt.folder_id == folder_id,
            QuizAttempt.created_at >= day_start,
            QuizAttempt.created_at < day_end,
        ).first()
        if has_attempt:
            streak += 1
            day -= timedelta(days=1)
        else:
            break

    # Daily completed (today)
    today_start = datetime(today.year, today.month, today.day, tzinfo=timezone.utc)
    daily_completed = QuizAttempt.query.filter(
        QuizAttempt.folder_id == folder_id,
        QuizAttempt.created_at >= today_start,
    ).count()

    # Badges
    badges = []
    total_attempt_count = len(all_attempts)
    avg = summary["avgScore"]

    # Attempt milestones
    if total_attempt_count >= 1:
        badges.append({"id": "first_step", "name": "Bước Đầu Tiên", "icon": "🎯", "description": "Hoàn thành quiz đầu tiên"})
    if total_attempt_count >= 10:
        badges.append({"id": "dedicated", "name": "Siêng Năng", "icon": "📚", "description": "Hoàn thành 10 lần làm bài"})
    if total_attempt_count >= 25:
        badges.append({"id": "grinder", "name": "Cày Cuốc Siêu Nhân", "icon": "⚡", "description": "Hoàn thành 25 lần làm bài"})
    if total_attempt_count >= 50:
        badges.append({"id": "master", "name": "Bậc Thầy", "icon": "👑", "description": "Hoàn thành 50 lần làm bài"})

    # Score milestones
    if summary["bestScore"] == 100:
        badges.append({"id": "perfect", "name": "Điểm Tuyệt Đối", "icon": "💯", "description": "Đạt 100% trong một quiz"})
    if avg >= 80 and total_attempt_count >= 5:
        badges.append({"id": "consistent", "name": "Ổn Định", "icon": "🌟", "description": "Điểm trung bình ≥ 80% (tối thiểu 5 lần)"})
    if avg >= 90 and total_attempt_count >= 10:
        badges.append({"id": "excellent", "name": "Xuất Sắc", "icon": "🏆", "description": "Điểm trung bình ≥ 90% (tối thiểu 10 lần)"})

    # Streak milestones
    if streak >= 3:
        badges.append({"id": "streak3", "name": "3 Ngày Liên Tiếp", "icon": "🔥", "description": "Duy trì streak 3 ngày"})
    if streak >= 7:
        badges.append({"id": "streak7", "name": "Tuần Lễ Bền Bỉ", "icon": "💪", "description": "Duy trì streak 7 ngày"})

    # Completion
    if completion_rate == 100 and total_quiz_sets >= 3:
        badges.append({"id": "complete_all", "name": "Chinh Phục Hết", "icon": "🎉", "description": "Làm hết tất cả quiz trong folder"})

    # Improvement
    if improvement_rate >= 10:
        badges.append({"id": "improver", "name": "Tiến Bộ Vượt Bậc", "icon": "📈", "description": "Cải thiện ≥ 10% so với trước"})

    gamification = {
        "level": level,
        "currentXP": xp_remaining,
        "xpToNextLevel": xp_for_level,
        "totalXP": total_xp,
        "streakDays": streak,
        "dailyGoal": 3,
        "dailyCompleted": daily_completed,
        "badges": badges,
    }

    # ── Category analysis (by difficulty, question type) ──
    difficulty_stats = defaultdict(lambda: {"attempts": 0, "totalScore": 0, "correct": 0, "total": 0})
    qtype_stats = defaultdict(lambda: {"attempts": 0, "totalScore": 0, "correct": 0, "total": 0})

    for a in all_attempts:
        qs = quiz_map.get(a.quiz_set_id)
        if not qs:
            continue
        cfg = qs.get_config()
        diff = cfg.get("difficulty", "mixed")
        qtype = cfg.get("questionType", "mixed")

        difficulty_stats[diff]["attempts"] += 1
        difficulty_stats[diff]["totalScore"] += a.score
        difficulty_stats[diff]["correct"] += a.correct_count
        difficulty_stats[diff]["total"] += a.total_questions

        qtype_stats[qtype]["attempts"] += 1
        qtype_stats[qtype]["totalScore"] += a.score
        qtype_stats[qtype]["correct"] += a.correct_count
        qtype_stats[qtype]["total"] += a.total_questions

    by_difficulty = {}
    for diff, s in difficulty_stats.items():
        by_difficulty[diff] = {
            "attempts": s["attempts"],
            "avgScore": round(s["totalScore"] / s["attempts"], 1) if s["attempts"] > 0 else 0,
            "accuracy": round(s["correct"] / s["total"] * 100, 1) if s["total"] > 0 else 0,
        }

    by_question_type = {}
    for qtype, s in qtype_stats.items():
        by_question_type[qtype] = {
            "attempts": s["attempts"],
            "avgScore": round(s["totalScore"] / s["attempts"], 1) if s["attempts"] > 0 else 0,
            "accuracy": round(s["correct"] / s["total"] * 100, 1) if s["total"] > 0 else 0,
        }

    category_analysis = {
        "byDifficulty": by_difficulty,
        "byQuestionType": by_question_type,
    }

    # ── Recent attempts (last 10) ──
    recent = sorted(all_attempts, key=lambda a: a.created_at, reverse=True)[:10]
    recent_attempts = []
    for a in recent:
        qs = quiz_map.get(a.quiz_set_id)
        recent_attempts.append({
            **a.to_dict(),
            "quizTitle": qs.title if qs else "Unknown",
        })

    return jsonify({
        "summary": summary,
        "progress": progress,
        "gamification": gamification,
        "categoryAnalysis": category_analysis,
        "quizBreakdown": quiz_breakdown,
        "recentAttempts": recent_attempts,
    })
