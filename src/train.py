"""
Train all TFT coaching models:
  Model A — MLP: predict placement from end-of-game features
  Model B — LSTM: predict placement from per-round sequence (live capture data)
  Model C — K-Means: cluster comps into archetypes
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.cluster import KMeans
from sklearn.metrics import accuracy_score, mean_absolute_error
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler
import pickle

PROCESSED_DIR = Path(__file__).parent.parent / "data" / "processed"
MODELS_DIR = Path(__file__).parent.parent / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Using device: {DEVICE}")


# ---------------------------------------------------------------------------
# Shared preprocessing
# ---------------------------------------------------------------------------

NUMERIC_COLS = [
    "level", "gold_left", "last_round", "level_efficiency",
    "active_trait_count", "unit_star_avg",
    "unit_count", "item_concentration", "damage_to_players", "players_eliminated",
]
CATEGORICAL_COLS = ["top_trait"]


def load_and_prep(path: Path) -> tuple[np.ndarray, np.ndarray, dict]:
    """
    Load match_features.csv, encode categoricals, scale numerics.
    Returns (X, y, encoders) where y is placement (1–8).
    """
    df = pd.read_csv(path).dropna(subset=["placement"])

    encoders: dict = {}

    # Encode categoricals as integer IDs
    cat_arrays = []
    for col in CATEGORICAL_COLS:
        le = LabelEncoder()
        df[col] = df[col].fillna("unknown").astype(str)
        encoded = le.fit_transform(df[col])
        encoders[f"le_{col}"] = le
        cat_arrays.append(encoded.reshape(-1, 1))

    # Scale numerics
    scaler = StandardScaler()
    num_arr = scaler.fit_transform(df[NUMERIC_COLS].fillna(0))
    encoders["scaler"] = scaler
    encoders["numeric_cols"] = NUMERIC_COLS
    encoders["categorical_cols"] = CATEGORICAL_COLS

    X = np.hstack([num_arr] + cat_arrays).astype(np.float32)
    y = df["placement"].values.astype(np.int64) - 1  # 0-indexed for CrossEntropy

    return X, y, encoders


# ---------------------------------------------------------------------------
# Model A: MLP placement predictor
# ---------------------------------------------------------------------------

class PlacementMLP(nn.Module):
    def __init__(self, input_dim: int, n_classes: int = 8):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, 128),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(64, n_classes),
        )

    def forward(self, x):
        return self.net(x)


def train_mlp(df_path: Path, epochs: int = 50, lr: float = 1e-3) -> None:
    print("\n=== Model A: MLP Placement Predictor ===")
    X, y, encoders = load_and_prep(df_path)

    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    X_tr = torch.tensor(X_train).to(DEVICE)
    y_tr = torch.tensor(y_train).to(DEVICE)
    X_vl = torch.tensor(X_val).to(DEVICE)
    y_vl = torch.tensor(y_val).to(DEVICE)

    model = PlacementMLP(input_dim=X.shape[1]).to(DEVICE)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.CrossEntropyLoss()

    best_val_loss = float("inf")
    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()
        loss = criterion(model(X_tr), y_tr)
        loss.backward()
        optimizer.step()

        if (epoch + 1) % 10 == 0:
            model.eval()
            with torch.no_grad():
                val_loss = criterion(model(X_vl), y_vl).item()
                preds = model(X_vl).argmax(dim=1).cpu().numpy()
                acc = accuracy_score(y_val, preds)
                mae = mean_absolute_error(y_val, preds)
            print(f"  Epoch {epoch+1:3d} | val_loss={val_loss:.4f} | acc={acc:.3f} | MAE={mae:.2f}")
            if val_loss < best_val_loss:
                best_val_loss = val_loss
                torch.save(model.state_dict(), MODELS_DIR / "mlp_best.pt")

    # Save encoders alongside the model
    with open(MODELS_DIR / "mlp_encoders.pkl", "wb") as f:
        pickle.dump({**encoders, "input_dim": X.shape[1]}, f)
    print(f"  Best val_loss={best_val_loss:.4f} | Model saved.")


# ---------------------------------------------------------------------------
# Model B: LSTM economy sequence predictor
# ---------------------------------------------------------------------------

class EconomyLSTM(nn.Module):
    def __init__(self, input_dim: int = 5, hidden: int = 64, layers: int = 2, n_classes: int = 8):
        super().__init__()
        self.lstm = nn.LSTM(input_dim, hidden, layers, batch_first=True, dropout=0.2)
        self.attn = nn.Linear(hidden, 1)
        self.fc = nn.Linear(hidden, n_classes)

    def forward(self, x):
        # x: (batch, seq_len, input_dim)
        out, _ = self.lstm(x)  # (batch, seq_len, hidden)
        # Attention over time steps
        weights = torch.softmax(self.attn(out), dim=1)  # (batch, seq_len, 1)
        context = (weights * out).sum(dim=1)             # (batch, hidden)
        return self.fc(context), weights.squeeze(-1)


def load_live_sequences(live_dir: Path, target_len: int = 20) -> tuple[np.ndarray, np.ndarray]:
    """
    Load all live session JSONs. Each session must have a 'placement' field
    (add it manually after the game or infer from match history).

    Returns X (n_sessions, target_len, 5) and y (n_sessions,).
    """
    sessions = list(live_dir.glob("session_*.json"))
    X_list, y_list = [], []

    for path in sessions:
        data = json.loads(path.read_text())
        if isinstance(data, dict):
            snaps = data.get("snapshots", [])
            placement = data.get("placement", None)
        else:
            snaps = data
            placement = None  # unknown — skip

        if placement is None:
            continue

        feats = []
        prev_gold = 0
        for snap in snaps:
            gold = snap.get("gold", 0)
            roll_delta = max(0, prev_gold - gold)
            prev_gold = gold
            feats.append([
                gold,
                snap.get("level", 1),
                snap.get("units_on_board", 0),
                roll_delta,
                snap.get("xp", 0),
            ])

        if not feats:
            continue

        # Pad or truncate to target_len
        if len(feats) < target_len:
            pad = [[0.0] * 5] * (target_len - len(feats))
            feats = feats + pad
        else:
            feats = feats[:target_len]

        X_list.append(feats)
        y_list.append(int(placement) - 1)

    if not X_list:
        return np.empty((0, target_len, 5)), np.empty(0)
    return np.array(X_list, dtype=np.float32), np.array(y_list, dtype=np.int64)


def train_lstm(live_dir: Path, epochs: int = 80, lr: float = 1e-3) -> None:
    print("\n=== Model B: LSTM Economy Sequence ===")
    X, y = load_live_sequences(live_dir)

    if len(X) < 10:
        print(f"  Only {len(X)} labeled sessions -- need >=10 to train LSTM. Skipping.")
        print("  Tip: add a 'placement' field to each session JSON after your game.")
        return

    X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, random_state=42)

    X_tr = torch.tensor(X_train).to(DEVICE)
    y_tr = torch.tensor(y_train).to(DEVICE)
    X_vl = torch.tensor(X_val).to(DEVICE)
    y_vl = torch.tensor(y_val).to(DEVICE)

    model = EconomyLSTM().to(DEVICE)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.CrossEntropyLoss()

    best_val_loss = float("inf")
    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()
        logits, _ = model(X_tr)
        loss = criterion(logits, y_tr)
        loss.backward()
        optimizer.step()

        if (epoch + 1) % 20 == 0:
            model.eval()
            with torch.no_grad():
                val_logits, _ = model(X_vl)
                val_loss = criterion(val_logits, y_vl).item()
                preds = val_logits.argmax(dim=1).cpu().numpy()
                mae = mean_absolute_error(y_val, preds)
            print(f"  Epoch {epoch+1:3d} | val_loss={val_loss:.4f} | MAE={mae:.2f}")
            if val_loss < best_val_loss:
                best_val_loss = val_loss
                torch.save(model.state_dict(), MODELS_DIR / "lstm_best.pt")

    print(f"  Best val_loss={best_val_loss:.4f} | Model saved.")


# ---------------------------------------------------------------------------
# Model C: K-Means comp clustering
# ---------------------------------------------------------------------------

def train_clustering(df_path: Path, n_clusters: int = 12) -> None:
    print("\n=== Model C: K-Means Comp Clustering ===")
    df = pd.read_csv(df_path).dropna(subset=["top_trait"])

    le = LabelEncoder()
    trait_encoded = le.fit_transform(df["top_trait"].fillna("unknown"))

    scaler = StandardScaler()
    numeric = scaler.fit_transform(df[["level_efficiency", "unit_star_avg", "active_trait_count"]].fillna(0))

    X_cluster = np.hstack([numeric, trait_encoded.reshape(-1, 1)])

    kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
    labels = kmeans.fit_predict(X_cluster)

    df["cluster"] = labels

    # Print cluster profiles
    print("\n  Cluster profiles (top trait + avg placement):")
    for c in range(n_clusters):
        subset = df[df["cluster"] == c]
        top = subset["top_trait"].value_counts().index[0] if len(subset) else "?"
        avg_place = subset["placement"].mean()
        print(f"  Cluster {c:2d}: {top:30s}  n={len(subset):4d}  avg_placement={avg_place:.2f}")

    with open(MODELS_DIR / "kmeans.pkl", "wb") as f:
        pickle.dump({
            "kmeans": kmeans,
            "scaler": scaler,
            "le_trait": le,
            "n_clusters": n_clusters,
        }, f)
    print(f"\n  K-Means saved (k={n_clusters}).")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    features_path = PROCESSED_DIR / "match_features.csv"
    live_dir = Path(__file__).parent.parent / "data" / "live"

    if not features_path.exists():
        print("No feature file found. Run: python src/features.py first.")
    else:
        train_mlp(features_path)
        train_clustering(features_path)
        train_lstm(live_dir)
